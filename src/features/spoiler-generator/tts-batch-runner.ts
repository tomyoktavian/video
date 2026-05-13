/**
 * TTS Batch Runner — generates narration audio for each spoiler segment.
 *
 * Runs sequentially in M2 (one TTS request at a time). M3 adds:
 *   - Parallel execution with max concurrency 3
 *   - Per-segment retry x2 with exponential backoff
 *   - Hard fail when more than 50% of segments fail
 *
 * Failed segments are surfaced as {@link TtsSegmentFailure} entries; the
 * caller (orchestrator) decides whether to abort or proceed with silent gaps.
 */

import { mediaLibraryService } from './deps/media-library'
import {
  getSpoilerTtsEngineTags,
  runSpoilerTts,
  type SpoilerTtsEngineConfig,
} from './tts-engine-adapter'
import type { SpoilerSegment, TtsBatchOutcome } from './types'

export interface TtsBatchInput {
  segments: readonly SpoilerSegment[]
  /** Active project id — required to save generated audio to media library. */
  projectId: string
  /** Engine + engine-specific voice/lang/quality. Defaults to Custom when omitted. */
  engineConfig?: SpoilerTtsEngineConfig
  /** Speed multiplier (0.25..4.0). Defaults to 1. */
  speed?: number
  /** M3: max concurrent TTS calls. Default 1 in M2 (sequential). */
  maxConcurrency?: number
  /** M3: retry attempts per segment on transient failure. Default 0 in M2. */
  maxRetries?: number
  signal?: AbortSignal
  onProgress?: (segmentIndex: number, total: number) => void
}

const DEFAULT_CUSTOM_ENGINE_CONFIG: SpoilerTtsEngineConfig = { engine: 'custom' }
const SPOILER_NARRATION_TAG = 'spoiler-narration'

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= attempts; i++) {
    if (signal?.aborted) {
      throw new DOMException('aborted', 'AbortError')
    }
    try {
      return await fn()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      lastErr = err
      if (i < attempts) {
        const delay = 200 * Math.pow(2, i)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          if (signal) {
            const onAbort = () => {
              clearTimeout(timer)
              reject(new DOMException('aborted', 'AbortError'))
            }
            signal.addEventListener('abort', onAbort, { once: true })
          }
        })
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function runOneSegment(
  segment: SpoilerSegment,
  input: TtsBatchInput,
): Promise<TtsBatchOutcome> {
  const engineConfig = input.engineConfig ?? DEFAULT_CUSTOM_ENGINE_CONFIG
  try {
    const ttsResult = await withRetry(
      () =>
        runSpoilerTts(engineConfig, {
          text: segment.narration,
          speed: input.speed ?? 1,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      input.maxRetries ?? 0,
      input.signal,
    )

    const media = await mediaLibraryService.importGeneratedAudio(ttsResult.file, input.projectId, {
      tags: [...getSpoilerTtsEngineTags(engineConfig), SPOILER_NARRATION_TAG],
    })

    return {
      index: segment.index,
      blob: ttsResult.blob,
      durationSec: ttsResult.duration,
      mediaId: media.id,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return {
      index: segment.index,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function runSequential(input: TtsBatchInput): Promise<TtsBatchOutcome[]> {
  const out: TtsBatchOutcome[] = []
  const total = input.segments.length
  for (let i = 0; i < input.segments.length; i++) {
    if (input.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError')
    }
    const segment = input.segments[i]!
    input.onProgress?.(i, total)
    const result = await runOneSegment(segment, input)
    out.push(result)
  }
  input.onProgress?.(total, total)
  return out
}

async function runParallel(input: TtsBatchInput, concurrency: number): Promise<TtsBatchOutcome[]> {
  const total = input.segments.length
  const out: TtsBatchOutcome[] = new Array(total)
  let nextIndex = 0
  let completed = 0

  const worker = async (): Promise<void> => {
    while (true) {
      if (input.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const slot = nextIndex++
      if (slot >= total) return
      const segment = input.segments[slot]!
      const result = await runOneSegment(segment, input)
      out[slot] = result
      completed += 1
      input.onProgress?.(completed, total)
    }
  }

  const workerCount = Math.min(concurrency, total)
  const workers = Array.from({ length: workerCount }, () => worker())
  await Promise.all(workers)
  return out
}

export async function runTtsBatch(input: TtsBatchInput): Promise<TtsBatchOutcome[]> {
  if (input.segments.length === 0) return []
  const concurrency = Math.max(1, Math.min(8, input.maxConcurrency ?? 1))
  if (concurrency === 1) return runSequential(input)
  return runParallel(input, concurrency)
}

export function summarizeBatch(results: readonly TtsBatchOutcome[]): {
  total: number
  succeeded: number
  failed: number
  failureRate: number
} {
  const total = results.length
  const succeeded = results.filter((r) => 'mediaId' in r && r.mediaId).length
  const failed = total - succeeded
  return {
    total,
    succeeded,
    failed,
    failureRate: total === 0 ? 0 : failed / total,
  }
}

export const __test = { runOneSegment, withRetry }
