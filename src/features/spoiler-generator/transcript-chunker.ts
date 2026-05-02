/**
 * Transcript chunker — splits very long transcripts into per-act chunks
 * (using gap > 8s as a scene boundary heuristic) and recursively summarizes
 * earlier chunks via the same LLM endpoint when the full transcript would
 * exceed the model's context window.
 *
 * Two-pass strategy:
 *   - Pass 1 (per chunk): model receives the chunk's transcript and produces
 *     a brief plot summary (~300 words). These summaries are cheap because
 *     they're generated with a smaller / faster model preset.
 *   - Pass 2 (final): the spoiler Script Writer receives the chunk summaries
 *     of all prior chunks plus the full text of the most recent chunk, then
 *     produces the final SpoilerScript.
 *
 * For M5, only the chunking + per-chunk summary scaffolding is wired up.
 * The summarization itself reuses the writeScript adapter with a different
 * system prompt (passed via systemPromptOverride).
 */

import type { MediaTranscriptSegment } from '@/types/storage'

export const SCENE_GAP_SECONDS = 8
export const MAX_CHUNK_CHAR_LENGTH = 50_000

export interface TranscriptChunk {
  /** 0-based ordering. */
  index: number
  /** Source-media seconds. */
  startSec: number
  /** Source-media seconds. */
  endSec: number
  segments: readonly MediaTranscriptSegment[]
  /** Char length of this chunk's text content. */
  charLength: number
}

function segmentCharLength(segment: MediaTranscriptSegment): number {
  return segment.text.length
}

/**
 * Detect natural scene boundaries by scanning for transcript gaps longer than
 * {@link SCENE_GAP_SECONDS}. Returns the start indexes of each new scene.
 */
export function findSceneBoundaries(
  segments: readonly MediaTranscriptSegment[],
  gapSec: number = SCENE_GAP_SECONDS,
): number[] {
  if (segments.length <= 1) return [0]
  const boundaries: number[] = [0]
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!
    const curr = segments[i]!
    if (curr.start - prev.end >= gapSec) {
      boundaries.push(i)
    }
  }
  return boundaries
}

/**
 * Split a transcript into chunks aligned to scene boundaries, with each
 * chunk capped at roughly {@link MAX_CHUNK_CHAR_LENGTH} characters of text.
 * When a single scene exceeds the cap (rare), it stays in one chunk
 * — chunking is a soft target, not a hard limit.
 */
export function chunkTranscript(
  segments: readonly MediaTranscriptSegment[],
  options: { maxCharLength?: number; sceneGapSec?: number } = {},
): TranscriptChunk[] {
  const maxChars = options.maxCharLength ?? MAX_CHUNK_CHAR_LENGTH
  const gapSec = options.sceneGapSec ?? SCENE_GAP_SECONDS
  if (segments.length === 0) return []

  const boundaries = findSceneBoundaries(segments, gapSec)
  // Set form for cheap membership lookup. We deliberately do NOT add a
  // sentinel for `segments.length` — see the loop's `lastBoundary` logic.
  const boundarySet = new Set(boundaries)

  const chunks: TranscriptChunk[] = []
  let cursorIdx = 0
  while (cursorIdx < segments.length) {
    let endIdx = cursorIdx + 1 // safety floor; ensures forward progress
    let runningChars = 0
    let lastBoundary = cursorIdx
    for (let i = cursorIdx; i < segments.length; i++) {
      const seg = segments[i]!
      runningChars += segmentCharLength(seg)
      const nextIsSceneBoundary = boundarySet.has(i + 1) && i + 1 < segments.length
      if (nextIsSceneBoundary) {
        lastBoundary = i + 1
        if (runningChars >= maxChars) {
          endIdx = lastBoundary
          break
        }
        // Continue scanning — this scene fit within budget.
        endIdx = lastBoundary
      } else if (i === segments.length - 1) {
        // End of transcript. If we've blown the budget AND have a real
        // scene boundary to fall back to, split there. Otherwise this is
        // the natural tail of the transcript and chunks everything.
        if (runningChars >= maxChars && lastBoundary > cursorIdx) {
          endIdx = lastBoundary
        } else {
          endIdx = segments.length
        }
        break
      } else {
        if (runningChars >= maxChars && lastBoundary > cursorIdx) {
          endIdx = lastBoundary
          break
        }
        endIdx = i + 1
      }
    }

    if (endIdx <= cursorIdx) endIdx = cursorIdx + 1
    const slice = segments.slice(cursorIdx, endIdx)
    if (slice.length > 0) {
      const charLength = slice.reduce((sum, s) => sum + segmentCharLength(s), 0)
      chunks.push({
        index: chunks.length,
        startSec: slice[0]?.start ?? 0,
        endSec: slice[slice.length - 1]?.end ?? 0,
        segments: slice,
        charLength,
      })
    }
    cursorIdx = endIdx
  }

  return chunks
}

export interface ChunkAndSummarizeResult {
  /** Original transcript or simplified flat list when chunked. */
  flatTranscript: readonly MediaTranscriptSegment[]
  /** Per-chunk summaries; empty when the transcript fit in one call. */
  chunkSummaries: readonly string[]
  /** Whether the chunker invoked the recursive summarization path. */
  didChunk: boolean
}

export interface ChunkAndSummarizeParams {
  segments: readonly MediaTranscriptSegment[]
  /** Threshold in chars above which chunking activates. */
  thresholdCharLength?: number
  /**
   * Async summarizer. The chunker invokes this for each chunk except the
   * last one (which is passed verbatim to the final Script Writer call).
   * Implementation detail: typically calls the same chat-completions adapter
   * with a "summarise this scene" system prompt.
   */
  summarize?: (chunk: TranscriptChunk) => Promise<string>
  signal?: AbortSignal
}

/**
 * Returns the transcript prepared for the Script Writer. When the transcript
 * is short, returns the original segments unchanged. When it's long, all
 * earlier chunks are summarised and the last chunk's raw text is passed
 * through verbatim — this keeps the final Script Writer call within the
 * model's context window while still letting the model reason about the
 * climax with full transcript fidelity.
 */
export async function chunkAndSummarizeIfNeeded(
  params: ChunkAndSummarizeParams,
): Promise<ChunkAndSummarizeResult> {
  const totalChars = params.segments.reduce((s, seg) => s + seg.text.length, 0)
  const threshold = params.thresholdCharLength ?? 60_000
  if (totalChars <= threshold || !params.summarize) {
    return { flatTranscript: params.segments, chunkSummaries: [], didChunk: false }
  }

  const chunks = chunkTranscript(params.segments)
  if (chunks.length <= 1) {
    return { flatTranscript: params.segments, chunkSummaries: [], didChunk: false }
  }

  // Summarize all but the last chunk sequentially. Each iteration checks the
  // abort signal both before and after the call so callers that abort during
  // the in-flight summarize promise fail fast instead of returning a partial.
  const earlyChunks = chunks.slice(0, -1)
  const lastChunk = chunks[chunks.length - 1]!
  const summaries: string[] = []
  for (const chunk of earlyChunks) {
    if (params.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const summary = await params.summarize(chunk)
    if (params.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    summaries.push(summary)
  }

  return {
    flatTranscript: lastChunk.segments,
    chunkSummaries: summaries,
    didChunk: true,
  }
}

export const __test = { findSceneBoundaries, chunkTranscript }
