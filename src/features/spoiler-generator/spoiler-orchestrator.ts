/**
 * Spoiler Generator orchestrator — state machine that runs the 8-stage
 * pipeline from "transcribe" through "compound assembled & ready to export".
 *
 * Stage flow (logical order):
 *   1. transcribing            — ensure transcript exists (skip if cached)
 *   2. writing-script          — LLM generates SpoilerScript
 *   3. resolving-highlights    — convert script segments → AssembleSegmentInput
 *   4. generating-narration    — TTS for each segment, save to media library
 *   5. syncing-durations       — recompute clip durations from TTS results
 *   6. applying-highlights     — assembleSingleCompound builds the comp
 *   7. inserting-subtitles     — embedded inside assembleSingleCompound
 *   8. inserting-cover         — (M4) insertCover on the new compound
 *   9. done
 *
 * Stages 7 and 8 are part of stage 6's `assembleSingleCompound` call (which
 * embeds subtitles when requested) and the future cover insertion (M4),
 * respectively. The state machine still surfaces them as discrete stages so
 * the UI progress stepper can show fine-grained progress.
 */

import { createLogger } from '@/shared/logging/logger'
import type { MediaTranscriptSegment } from '@/types/storage'

import { assembleSingleCompound, type AssembleSegmentInput } from './compound-assembly'
import { insertCover, persistCoverFrame, renderCoverFrame } from './deps/compound-cover'
import {
  useMediaLibraryStore,
  mediaLibraryService,
  mediaTranscriptionService,
} from './deps/media-library'
import {
  getCustomAiCaptionMakerConfig,
  isCaptionMakerConfigured,
  useSettingsStore,
} from './deps/settings'
import { getTranscript } from './deps/transcription'
import { useProjectStore } from './deps/project'
import { useTimelineSettingsStore } from './deps/timeline'
import { prepareSpoilerScript, TranscriptMissingError } from './script-writer-service'
import { runTtsBatch, summarizeBatch } from './tts-batch-runner'
import type {
  SpoilerInput,
  SpoilerProgress,
  SpoilerResult,
  SpoilerScript,
  TtsBatchOutcome,
} from './types'

/** Concurrency cap for narration re-transcription. Mirrors `runTtsBatch`. */
const NARRATION_TRANSCRIBE_CONCURRENCY = 3

const logger = createLogger('SpoilerOrchestrator')

class SpoilerAbortError extends DOMException {
  constructor() {
    super('Spoiler generation aborted by user.', 'AbortError')
  }
}

export interface RunSpoilerOptions {
  onProgress: (progress: SpoilerProgress) => void
  signal?: AbortSignal
}

interface PipelineContext {
  input: SpoilerInput
  options: RunSpoilerOptions
  fps: number
  canvasWidth: number
  canvasHeight: number
  /** Media metadata for the source film. */
  sourceMedia: ReturnType<typeof useMediaLibraryStore.getState>['mediaById'][string] | undefined
  sourceBlobUrl: string | null
  cleanupTasks: Array<() => void | Promise<void>>
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SpoilerAbortError()
}

function emit(ctx: PipelineContext, progress: SpoilerProgress): void {
  ctx.options.onProgress(progress)
}

async function stageTranscribe(ctx: PipelineContext): Promise<void> {
  emit(ctx, { stage: 'transcribing', message: 'Checking film transcript...' })
  checkAbort(ctx.options.signal)

  // Short-circuit when transcript already exists in workspace storage —
  // `transcribeMedia` does NOT auto-skip, so calling it would trigger a
  // full re-run (5–10 min for a 1h film). The dialog already gates entry
  // on transcript availability, so we expect this fast path to win.
  try {
    const existing = await getTranscript(ctx.input.mediaId)
    if (existing && existing.segments.length > 0) {
      emit(ctx, {
        stage: 'transcribing',
        message: `Transcript already exists (${existing.segments.length} segments), continuing...`,
      })
      return
    }
  } catch (err) {
    logger.warn('Transcript existence check failed; will trigger fresh run', err)
  }

  emit(ctx, {
    stage: 'transcribing',
    message: 'No transcript yet. Starting transcription via Custom AI...',
  })

  // Spoiler Generator is Custom-AI-only. Local Whisper would slow Stage 1
  // by 30-90 minutes for a 1-2 hour film with no privacy benefit (Stages 2
  // and 4 require cloud anyway). The media-card menu and dialog gate entry
  // on Caption Maker configuration; this guard is the runtime safety net.
  const captionConfig = getCustomAiCaptionMakerConfig()
  if (!isCaptionMakerConfigured(captionConfig)) {
    throw new Error(
      'Custom AI Caption Maker is not configured. Open Settings → AI → Custom AI → Caption Maker and fill in base URL + API key + model.',
    )
  }

  try {
    await mediaTranscriptionService.transcribeMedia(ctx.input.mediaId, {
      providerId: 'openai-compatible',
      model: captionConfig.model,
      ...(captionConfig.language ? { language: captionConfig.language } : {}),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw err instanceof Error ? err : new Error(String(err))
  }
}

async function stageWriteScript(ctx: PipelineContext): Promise<SpoilerScript> {
  emit(ctx, {
    stage: 'writing-script',
    message: 'AI is writing the spoiler script from the transcript...',
  })
  checkAbort(ctx.options.signal)

  try {
    const script = await prepareSpoilerScript({
      mediaId: ctx.input.mediaId,
      targetDurationSec: ctx.input.targetDurationSec,
      narrationLanguage: ctx.input.narrationLanguage,
      clipDurationSec: ctx.input.clipDurationSec,
      ...(ctx.options.signal ? { signal: ctx.options.signal } : {}),
    })
    if (script.segments.length === 0) {
      throw new Error(
        'AI returned no usable spoiler segments. Try a longer film or a different model.',
      )
    }
    return script
  } catch (err) {
    if (err instanceof TranscriptMissingError) {
      throw new Error(
        'Transcript not available. Run "Transcribe" on this media first or check Caption Maker config.',
      )
    }
    throw err
  }
}

function resolveSegments(
  ctx: PipelineContext,
  script: SpoilerScript,
  ttsResults: readonly TtsBatchOutcome[],
): AssembleSegmentInput[] {
  emit(ctx, { stage: 'resolving-highlights', message: 'Aligning clips with narration...' })
  return script.segments.map((segment, i) => {
    const tts = ttsResults[i]
    const ttsSec = tts && 'durationSec' in tts ? tts.durationSec : 0
    const sourceSec = segment.selectedClipRange.endSec - segment.selectedClipRange.startSec
    // Sync strategy: clip duration tracks narration duration + 0.3s buffer.
    // If TTS failed, fall back to source-range duration so the segment still appears.
    const finalDurationSec = ttsSec > 0 ? Math.max(0.5, ttsSec + 0.3) : Math.max(0.5, sourceSec)
    return {
      index: segment.index,
      sourceStartSec: segment.selectedClipRange.startSec,
      sourceEndSec: segment.selectedClipRange.endSec,
      narration: segment.narration,
      finalDurationSec,
    }
  })
}

async function stageGenerateNarration(
  ctx: PipelineContext,
  script: SpoilerScript,
  projectId: string,
): Promise<TtsBatchOutcome[]> {
  const total = script.segments.length
  emit(ctx, {
    stage: 'generating-narration',
    message: `Generating narration audio (0/${total})...`,
    segmentTotal: total,
    segmentIndex: 0,
  })

  const results = await runTtsBatch({
    segments: script.segments,
    projectId,
    ...(ctx.input.voicePreset ? { voice: ctx.input.voicePreset } : {}),
    ...(ctx.input.voiceSpeed !== undefined ? { speed: ctx.input.voiceSpeed } : {}),
    maxConcurrency: 3,
    maxRetries: 2,
    ...(ctx.options.signal ? { signal: ctx.options.signal } : {}),
    onProgress: (current) => {
      emit(ctx, {
        stage: 'generating-narration',
        message: `Generating narration audio (${current}/${total})...`,
        segmentTotal: total,
        segmentIndex: current,
        fraction: total > 0 ? current / total : 0,
      })
    },
  })

  const summary = summarizeBatch(results)
  if (summary.failureRate > 0.5) {
    throw new Error(
      `TTS failed for ${summary.failed}/${summary.total} segments. ` +
        'Check the Custom AI Text-to-Speech configuration and try again.',
    )
  }
  return results
}

async function stageTranscribeNarration(
  ctx: PipelineContext,
  ttsResults: readonly TtsBatchOutcome[],
): Promise<Map<number, MediaTranscriptSegment[]>> {
  const transcripts = new Map<number, MediaTranscriptSegment[]>()
  if (!ctx.input.addSubtitles) return transcripts

  const successes = ttsResults.filter(
    (r): r is TtsBatchOutcome & { mediaId: string } => 'mediaId' in r && !!r.mediaId,
  )
  if (successes.length === 0) return transcripts

  const captionConfig = getCustomAiCaptionMakerConfig()
  if (!isCaptionMakerConfigured(captionConfig)) {
    logger.warn('Caption Maker not configured; skipping narration transcription.')
    return transcripts
  }

  const total = successes.length
  emit(ctx, {
    stage: 'transcribing-narration',
    message: `Transcribing narration for subtitle timing (0/${total})...`,
    segmentTotal: total,
    segmentIndex: 0,
  })

  let completed = 0
  let cursor = 0
  const inFlight: Promise<void>[] = []

  const runOne = async (success: TtsBatchOutcome & { mediaId: string }): Promise<void> => {
    checkAbort(ctx.options.signal)
    try {
      const transcript = await mediaTranscriptionService.transcribeMedia(success.mediaId, {
        providerId: 'openai-compatible',
        model: captionConfig.model,
        ...(ctx.input.narrationLanguage ? { language: ctx.input.narrationLanguage } : {}),
      })
      if (transcript.segments.length > 0) {
        transcripts.set(success.index, transcript.segments)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      logger.warn(`Failed to transcribe narration for segment ${success.index}`, err)
    } finally {
      completed += 1
      emit(ctx, {
        stage: 'transcribing-narration',
        message: `Transcribing narration for subtitle timing (${completed}/${total})...`,
        segmentTotal: total,
        segmentIndex: completed,
        fraction: total > 0 ? completed / total : 0,
      })
    }
  }

  while (cursor < successes.length || inFlight.length > 0) {
    while (inFlight.length < NARRATION_TRANSCRIBE_CONCURRENCY && cursor < successes.length) {
      const success = successes[cursor++]!
      const promise = runOne(success).finally(() => {
        const idx = inFlight.indexOf(promise)
        if (idx >= 0) inFlight.splice(idx, 1)
      })
      inFlight.push(promise)
    }
    if (inFlight.length > 0) {
      await Promise.race(inFlight)
    }
  }

  return transcripts
}

async function stageAssembleCompound(
  ctx: PipelineContext,
  script: SpoilerScript,
  segments: readonly AssembleSegmentInput[],
  ttsResults: readonly TtsBatchOutcome[],
  narrationTranscriptsById: ReadonlyMap<number, MediaTranscriptSegment[]>,
): Promise<{ compositionId: string | null; totalDurationFrames: number; segmentsPlaced: number }> {
  emit(ctx, { stage: 'syncing-durations', message: 'Syncing clip durations...' })
  checkAbort(ctx.options.signal)

  emit(ctx, { stage: 'applying-highlights', message: 'Building the spoiler compound clip...' })

  // Build narration media-id map from TTS results; failures get no entry.
  const narrationMediaById = new Map<
    number,
    { mediaId: string; blobUrl: string; durationSec: number }
  >()
  for (const result of ttsResults) {
    if ('mediaId' in result && result.mediaId) {
      try {
        const blobUrl = await mediaLibraryService.getMediaBlobUrl(result.mediaId)
        if (blobUrl) {
          narrationMediaById.set(result.index, {
            mediaId: result.mediaId,
            blobUrl,
            durationSec: result.durationSec,
          })
          ctx.cleanupTasks.push(() => URL.revokeObjectURL(blobUrl))
        }
      } catch (err) {
        logger.warn(`Failed to resolve narration blob URL for segment ${result.index}`, err)
      }
    }
  }

  if (!ctx.sourceMedia) throw new Error('Source media metadata not available.')
  if (!ctx.sourceBlobUrl) throw new Error('Source media blob URL not available.')

  const granularity =
    ctx.input.subtitleGranularity ?? useSettingsStore.getState().defaultSubtitleGranularity

  const result = assembleSingleCompound({
    name: script.title || 'Spoiler',
    sourceMedia: ctx.sourceMedia,
    sourceMediaId: ctx.input.mediaId,
    sourceBlobUrl: ctx.sourceBlobUrl,
    sourceThumbnailUrl: null,
    segments,
    ttsResults,
    narrationMediaById,
    narrationTranscriptsById,
    fps: ctx.fps,
    canvasWidth: ctx.canvasWidth,
    canvasHeight: ctx.canvasHeight,
    insertSubtitles: ctx.input.addSubtitles,
    includeOriginalAudio: ctx.input.includeOriginalAudio,
    subtitleGranularity: granularity,
    metadataContext: {
      voiceId: ctx.input.voicePreset ?? null,
      speed: ctx.input.voiceSpeed ?? 1,
      language: ctx.input.narrationLanguage,
      scriptTitle: script.title || 'Spoiler',
      ...(script.synopsis ? { scriptSynopsis: script.synopsis } : {}),
      granularity,
      addSubtitles: ctx.input.addSubtitles,
      generateCover: ctx.input.generateCover,
      includeOriginalAudio: ctx.input.includeOriginalAudio,
    },
  })

  if (ctx.input.addSubtitles) {
    emit(ctx, { stage: 'inserting-subtitles', message: 'Adding subtitles...' })
  }

  return result
}

async function stageInsertCover(
  ctx: PipelineContext,
  script: SpoilerScript,
  compositionId: string | null,
): Promise<void> {
  if (!ctx.input.generateCover || !compositionId) return
  emit(ctx, { stage: 'inserting-cover', message: 'Generating spoiler cover...' })
  try {
    // Render an early frame from the assembled compound (frame 30 ≈ 1s in @ 30fps).
    const blob = await renderCoverFrame(compositionId, 30, { width: 1280 })
    const dims = await loadBlobDimensions(blob)
    const persisted = await persistCoverFrame(compositionId, blob, dims.width, dims.height)
    insertCover({
      compositionId,
      durationSec: 4,
      frameMediaId: persisted.id,
      frameSrc: persisted.opfsPath ?? '',
      frameWidth: dims.width,
      frameHeight: dims.height,
      primary: script.title || 'Spoiler',
      ...(script.synopsis ? { secondary: truncate(script.synopsis, 80) } : {}),
    })
  } catch (err) {
    logger.warn('Cover insertion failed; spoiler completes without cover.', err)
  }
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value
  return value.slice(0, maxLen - 1).trimEnd() + '…'
}

async function loadBlobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') {
    return { width: 1280, height: 720 }
  }
  try {
    const bitmap = await createImageBitmap(blob)
    const dims = { width: bitmap.width, height: bitmap.height }
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()
    return dims
  } catch {
    return { width: 1280, height: 720 }
  }
}

async function ensureSourceMediaContext(ctx: PipelineContext): Promise<void> {
  const mediaState = useMediaLibraryStore.getState()
  ctx.sourceMedia = mediaState.mediaById[ctx.input.mediaId]
  if (!ctx.sourceMedia) {
    // Fallback: refresh from disk and look again.
    const projectId = useProjectStore.getState().currentProject?.id
    if (projectId) {
      const all = await mediaLibraryService.getMediaForProject(projectId)
      ctx.sourceMedia = all.find((m) => m.id === ctx.input.mediaId)
    }
  }
  if (!ctx.sourceMedia) {
    throw new Error(`Media ${ctx.input.mediaId} not found in the library.`)
  }
  ctx.sourceBlobUrl = await mediaLibraryService.getMediaBlobUrl(ctx.input.mediaId)
  if (!ctx.sourceBlobUrl) {
    throw new Error(`Source media blob URL not available for ${ctx.input.mediaId}.`)
  }
  const blobUrl = ctx.sourceBlobUrl
  ctx.cleanupTasks.push(() => URL.revokeObjectURL(blobUrl))
}

async function runCleanup(ctx: PipelineContext): Promise<void> {
  for (const task of ctx.cleanupTasks.reverse()) {
    try {
      await task()
    } catch (err) {
      logger.warn('Cleanup task failed', err)
    }
  }
  ctx.cleanupTasks.length = 0
}

export async function runSpoilerPipeline(
  input: SpoilerInput,
  options: RunSpoilerOptions,
): Promise<SpoilerResult> {
  const projectId = useProjectStore.getState().currentProject?.id
  if (!projectId) {
    throw new Error('Open a project before generating a spoiler.')
  }

  const fps = useTimelineSettingsStore.getState().fps || 30
  const project = useProjectStore.getState().currentProject
  const canvasWidth = project?.metadata?.width ?? 1920
  const canvasHeight = project?.metadata?.height ?? 1080

  const ctx: PipelineContext = {
    input,
    options,
    fps,
    canvasWidth,
    canvasHeight,
    sourceMedia: undefined,
    sourceBlobUrl: null,
    cleanupTasks: [],
  }

  try {
    await ensureSourceMediaContext(ctx)

    await stageTranscribe(ctx)
    const script = await stageWriteScript(ctx)
    const ttsResults = await stageGenerateNarration(ctx, script, projectId)
    const narrationTranscripts = await stageTranscribeNarration(ctx, ttsResults)
    const segments = resolveSegments(ctx, script, ttsResults)
    const assembled = await stageAssembleCompound(
      ctx,
      script,
      segments,
      ttsResults,
      narrationTranscripts,
    )
    await stageInsertCover(ctx, script, assembled.compositionId)

    const ttsSummary = summarizeBatch(ttsResults)
    const totalDurationSec = segments.reduce((acc, s) => acc + s.finalDurationSec, 0)

    options.onProgress({
      stage: 'done',
      message: 'Spoiler ready! Open the compound clip to preview.',
    })

    await runCleanup(ctx)

    return {
      compositionId: assembled.compositionId ?? '',
      segmentsRequested: script.segments.length,
      segmentsApplied: assembled.segmentsPlaced,
      narrationsGenerated: ttsSummary.succeeded,
      narrationsFailed: ttsSummary.failed,
      totalDurationSec,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      await runCleanup(ctx)
      options.onProgress({ stage: 'idle', message: 'Cancelled.' })
      throw err
    }
    options.onProgress({
      stage: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
    await runCleanup(ctx)
    throw err
  }
}
