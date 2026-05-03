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
import type { ImageItem, TimelineItem } from '@/types/timeline'

import {
  assembleSingleCompound,
  type AssembleSegmentInput,
  type BoundaryCoverMedia,
  type EpisodeAssemblyContext,
} from './compound-assembly'
import { insertCover, persistCoverFrame, renderCoverFrame } from './deps/compound-cover'
import {
  useMediaLibraryStore,
  mediaLibraryService,
  mediaTranscriptionService,
} from './deps/media-library'
import { getCustomAiCaptionMakerConfig, isCaptionMakerConfigured } from './deps/settings'
import { getTranscript } from './deps/transcription'
import { useProjectStore } from './deps/project'
import { useCompositionsStore, useTimelineSettingsStore } from './deps/timeline'
import { planEpisodes, type EpisodeBucket } from './episode-planner'
import { generateEpisodeNarrations, type EpisodeNarrationLine } from './episode-narration-generator'
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

/** Default episode duration bounds (seconds). */
const EPISODE_DEFAULT_MIN_SEC = 60
const EPISODE_DEFAULT_MAX_SEC = 120
/** Hard clamp on the episode bounds to prevent runaway / sub-min values. */
const EPISODE_HARD_MIN_SEC = 60
const EPISODE_HARD_MAX_SEC = 120

/** Default boundary templates if the dialog didn't supply one. */
const EPISODE_DEFAULT_OPENING = 'Selamat datang di episode {n}'
const EPISODE_DEFAULT_CLOSING = 'Lanjutkan nonton di episode {next}'

/** Default cover preroll duration in seconds — matches AddCoverDialog. */
const COVER_DURATION_DEFAULT_SEC = 4
const COVER_DURATION_MIN_SEC = 0.5
const COVER_DURATION_MAX_SEC = 5

/** Default + bounds for the boundary narration speed multiplier. */
const BOUNDARY_NARRATION_SPEED_DEFAULT = 1
const BOUNDARY_NARRATION_SPEED_MIN = 0.5
const BOUNDARY_NARRATION_SPEED_MAX = 4

function clampCoverDurationSec(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return COVER_DURATION_DEFAULT_SEC
  }
  return Math.max(COVER_DURATION_MIN_SEC, Math.min(COVER_DURATION_MAX_SEC, value))
}

function clampBoundaryNarrationSpeed(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return BOUNDARY_NARRATION_SPEED_DEFAULT
  }
  return Math.max(BOUNDARY_NARRATION_SPEED_MIN, Math.min(BOUNDARY_NARRATION_SPEED_MAX, value))
}

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
  const segments = script.segments.map((segment, i) => {
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

  // Body must total at least the user's chosen `targetDurationSec`. TTS is
  // typically faster than the LLM-estimated reading pace, so the natural
  // sum is shorter than the target. Distribute the deficit evenly across
  // segments so each video clip plays past its narration tail (silent
  // video continuation). The full-spoiler compound's body matches the
  // target exactly; per-episode totals add boundary overhead on top
  // (cover + opening + closing) which is acceptable per product spec
  // ("tidak boleh kurang, boleh lebih sedikit").
  const total = segments.reduce((acc, s) => acc + s.finalDurationSec, 0)
  const target = ctx.input.targetDurationSec
  if (segments.length > 0 && total < target) {
    const padPerSegment = (target - total) / segments.length
    for (const seg of segments) seg.finalDurationSec += padPerSegment
  }
  return segments
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
        const wordsCount = transcript.segments.reduce(
          (sum, seg) => sum + (seg.words?.length ?? 0),
          0,
        )
        logger.info(
          `Narration transcribed for segment ${success.index}: ${transcript.segments.length} segments, ${wordsCount} words`,
        )
      } else {
        logger.warn(
          `Narration transcript empty for segment ${success.index} — subtitle will fall back to script text`,
        )
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
  options: { nameOverride?: string; progressMessage?: string } = {},
): Promise<{ compositionId: string | null; totalDurationFrames: number; segmentsPlaced: number }> {
  emit(ctx, { stage: 'syncing-durations', message: 'Syncing clip durations...' })
  checkAbort(ctx.options.signal)

  emit(ctx, {
    stage: 'applying-highlights',
    message: options.progressMessage ?? 'Building the spoiler compound clip...',
  })

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

  const baseTitle = script.title || 'Spoiler'
  const result = assembleSingleCompound({
    name: options.nameOverride ?? baseTitle,
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
    ...(typeof ctx.input.wordsPerCaption === 'number'
      ? { wordsPerCaption: ctx.input.wordsPerCaption }
      : {}),
    includeOriginalAudio: ctx.input.includeOriginalAudio,
    metadataContext: {
      voiceId: ctx.input.voicePreset ?? null,
      speed: ctx.input.voiceSpeed ?? 1,
      language: ctx.input.narrationLanguage,
      scriptTitle: baseTitle,
      ...(script.synopsis ? { scriptSynopsis: script.synopsis } : {}),
      addSubtitles: ctx.input.addSubtitles,
      ...(typeof ctx.input.wordsPerCaption === 'number'
        ? { wordsPerCaption: ctx.input.wordsPerCaption }
        : {}),
      generateCover: ctx.input.generateCover,
      includeOriginalAudio: ctx.input.includeOriginalAudio,
    },
  })

  if (ctx.input.addSubtitles) {
    emit(ctx, { stage: 'inserting-subtitles', message: 'Adding subtitles...' })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────
// Episode Mode helpers
// ─────────────────────────────────────────────────────────────────────────

interface EpisodeBoundaryNarrationsByEpisode {
  /** Map: episodeIndex (1-based) → opening narration line. */
  openings: Map<number, EpisodeNarrationLine>
  /** Map: episodeIndex (1-based) → closing narration line. */
  closings: Map<number, EpisodeNarrationLine>
}

function clampEpisodeBounds(input: SpoilerInput): {
  minDurationSec: number
  maxDurationSec: number
} {
  const rawMin = input.episodeMinDurationSec ?? EPISODE_DEFAULT_MIN_SEC
  const rawMax = input.episodeMaxDurationSec ?? EPISODE_DEFAULT_MAX_SEC
  let min = Math.max(EPISODE_HARD_MIN_SEC, Math.min(EPISODE_HARD_MAX_SEC - 1, rawMin))
  let max = Math.max(EPISODE_HARD_MIN_SEC + 1, Math.min(EPISODE_HARD_MAX_SEC, rawMax))
  if (min >= max) {
    // Defensive: caller should validate, but ensure we never produce an
    // invalid range that would crash `planEpisodes`.
    min = EPISODE_DEFAULT_MIN_SEC
    max = EPISODE_DEFAULT_MAX_SEC
  }
  return { minDurationSec: min, maxDurationSec: max }
}

function stagePlanEpisodes(
  ctx: PipelineContext,
  segments: readonly AssembleSegmentInput[],
): EpisodeBucket[] {
  emit(ctx, { stage: 'planning-episodes', message: 'Planning episodes...' })
  const { minDurationSec, maxDurationSec } = clampEpisodeBounds(ctx.input)
  const segmentDurationsSec = segments.map((s) => s.finalDurationSec)

  // Hard validation: each episode needs at least one segment because the
  // narration audio is a single TTS clip per segment and cannot be split
  // across episodes. When the script writer LLM returned fewer segments
  // than the user's requested episode count, we surface a clear error
  // instead of silently producing a degenerate single-episode result.
  const requestedEpisodeCount =
    typeof ctx.input.episodeCount === 'number' && ctx.input.episodeCount > 0
      ? Math.floor(ctx.input.episodeCount)
      : undefined
  if (typeof requestedEpisodeCount === 'number' && requestedEpisodeCount > segments.length) {
    throw new Error(
      `Script writer produced only ${segments.length} segment${segments.length === 1 ? '' : 's'}, but you requested ${requestedEpisodeCount} episodes. ` +
        `Each episode needs at least one segment, so reduce "Number of episodes" to ≤ ${segments.length} ` +
        `or use a Vision Analyzer model that produces more granular segments (e.g. lower the "Average clip duration per segment").`,
    )
  }

  const targetEpisodeCount = requestedEpisodeCount

  const buckets = planEpisodes({
    segmentDurationsSec,
    minDurationSec,
    maxDurationSec,
    ...(targetEpisodeCount !== undefined ? { targetEpisodeCount } : {}),
  })
  if (buckets.length === 0) {
    throw new Error('Episode planner produced zero buckets — segments are empty.')
  }
  return buckets
}

async function stageGenerateEpisodeNarration(
  ctx: PipelineContext,
  buckets: readonly EpisodeBucket[],
  projectId: string,
): Promise<EpisodeBoundaryNarrationsByEpisode> {
  const total = buckets.reduce(
    (acc, b) => acc + (b.includesOpening ? 1 : 0) + (b.includesClosing ? 1 : 0),
    0,
  )
  emit(ctx, {
    stage: 'generating-episode-narration',
    message: `Generating episode openings/closings (0/${total})...`,
    segmentTotal: total,
    segmentIndex: 0,
  })

  if (total === 0) {
    return { openings: new Map(), closings: new Map() }
  }

  const openingTemplate = ctx.input.episodeOpeningTemplate?.trim() || EPISODE_DEFAULT_OPENING
  const closingTemplate = ctx.input.episodeClosingTemplate?.trim() || EPISODE_DEFAULT_CLOSING

  const lines = await generateEpisodeNarrations({
    episodes: buckets,
    openingTemplate,
    closingTemplate,
    projectId,
    ...(ctx.input.voicePreset ? { voice: ctx.input.voicePreset } : {}),
    ...(ctx.input.voiceSpeed !== undefined ? { speed: ctx.input.voiceSpeed } : {}),
    ...(ctx.options.signal ? { signal: ctx.options.signal } : {}),
    onProgress: (current) => {
      emit(ctx, {
        stage: 'generating-episode-narration',
        message: `Generating episode openings/closings (${current}/${total})...`,
        segmentTotal: total,
        segmentIndex: current,
        fraction: total > 0 ? current / total : 0,
      })
    },
  })

  // Index for fast lookup during assembly. Also register blob revoke as
  // cleanup so we don't leak object URLs on failure / abort.
  const openings = new Map<number, EpisodeNarrationLine>()
  const closings = new Map<number, EpisodeNarrationLine>()
  for (const line of lines) {
    if (line.kind === 'opening') openings.set(line.episodeIndex, line)
    else closings.set(line.episodeIndex, line)
    const url = line.blobUrl
    ctx.cleanupTasks.push(() => URL.revokeObjectURL(url))
  }
  return { openings, closings }
}

/**
 * Render a cover frame from the FIRST already-assembled episode and persist
 * it to the media library. The resulting media id is shared across all
 * sibling episodes in this run.
 */
async function renderAndPersistEpisodeCover(
  firstEpisodeCompositionId: string,
): Promise<BoundaryCoverMedia | null> {
  try {
    const blob = await renderCoverFrame(firstEpisodeCompositionId, 30, { width: 1280 })
    const dims = await loadBlobDimensions(blob)
    const persisted = await persistCoverFrame(
      firstEpisodeCompositionId,
      blob,
      dims.width,
      dims.height,
    )
    return {
      frameMediaId: persisted.id,
      frameSrc: persisted.opfsPath ?? '',
      frameWidth: dims.width,
      frameHeight: dims.height,
    }
  } catch (err) {
    logger.warn('Episode cover render failed; episodes will use text-only boundaries.', err)
    return null
  }
}

/**
 * Convert the dialog's pre-generated AI cover (already persisted to the
 * media library before the pipeline started) into the `BoundaryCoverMedia`
 * shape the assembly stage expects. Returns null when the input has no
 * pre-generated cover.
 */
function resolvePreGeneratedCover(ctx: PipelineContext): BoundaryCoverMedia | null {
  const pre = ctx.input.preGeneratedCover
  if (!pre) return null
  return {
    frameMediaId: pre.mediaId,
    frameSrc: pre.src,
    frameWidth: pre.width,
    frameHeight: pre.height,
  }
}

/**
 * Inject a cover image item into both boundary windows of a previously
 * assembled compound. Used to retrofit episode 1 (which is built before the
 * cover exists, so the cover frame can be rendered FROM it).
 */
function patchCompoundCoverBoundaries(args: {
  compositionId: string
  cover: BoundaryCoverMedia
  /** Frame ranges to add cover image items to. */
  windows: ReadonlyArray<{
    from: number
    durationInFrames: number
    label: string
  }>
}): void {
  const compStore = useCompositionsStore.getState()
  const comp = compStore.getComposition(args.compositionId)
  if (!comp) {
    logger.warn(`Cannot patch cover: composition ${args.compositionId} not found`)
    return
  }
  const boundaryTrack = comp.tracks.find((t) => t.name === 'Spoiler Boundary')
  if (!boundaryTrack) {
    logger.warn('Cannot patch cover: no Spoiler Boundary track')
    return
  }
  const newImages: ImageItem[] = args.windows.map((w) => ({
    id: crypto.randomUUID(),
    type: 'image',
    trackId: boundaryTrack.id,
    from: w.from,
    durationInFrames: w.durationInFrames,
    label: w.label,
    mediaId: args.cover.frameMediaId,
    originId: crypto.randomUUID(),
    src: args.cover.frameSrc,
    sourceWidth: args.cover.frameWidth,
    sourceHeight: args.cover.frameHeight,
    transform: { x: 0, y: 0, rotation: 0, opacity: 1 },
  })) as ImageItem[]

  const nextItems: TimelineItem[] = [...comp.items, ...newImages]
  compStore.updateComposition(args.compositionId, {
    items: nextItems,
    spoilerMetadata: comp.spoilerMetadata
      ? { ...comp.spoilerMetadata, coverFrameMediaId: args.cover.frameMediaId }
      : comp.spoilerMetadata,
  })
}

/**
 * Episode-mode loop assembly. Builds episode 1 first WITHOUT a cover (so we
 * can render the cover from it), persists the cover, then either:
 *   - patches episode 1's boundary windows with the rendered cover image, and
 *   - assembles episodes 2..N with the same cover baked in.
 *
 * If `generateCover === false`, all episodes are built without cover image —
 * boundary windows still emit text + audio.
 */
async function assembleEpisodesLoop(
  ctx: PipelineContext,
  script: SpoilerScript,
  segments: readonly AssembleSegmentInput[],
  ttsResults: readonly TtsBatchOutcome[],
  narrationTranscriptsById: ReadonlyMap<number, MediaTranscriptSegment[]>,
  buckets: readonly EpisodeBucket[],
  boundaries: EpisodeBoundaryNarrationsByEpisode,
  parentSpoilerRunId: string,
  preGeneratedCover: BoundaryCoverMedia | null,
): Promise<{
  compositionIds: string[]
  totalDurationFrames: number
  segmentsPlaced: number
  cover: BoundaryCoverMedia | null
}> {
  if (!ctx.sourceMedia) throw new Error('Source media metadata not available.')
  if (!ctx.sourceBlobUrl) throw new Error('Source media blob URL not available.')

  const narrationMediaById = await buildNarrationMediaMap(ctx, ttsResults)

  const baseTitle = script.title || 'Spoiler'
  const N = buckets.length

  emit(ctx, { stage: 'syncing-durations', message: 'Syncing clip durations...' })
  checkAbort(ctx.options.signal)

  const compositionIds: string[] = []
  let totalDurationFrames = 0
  let segmentsPlaced = 0

  // Whether the run will produce a cover (pre-generated or rendered later)
  // so we can reserve the cover-preroll window upfront in every episode.
  // When neither path is requested, prerollSec = 0 (no leading silent slot).
  const willHaveCover = !!preGeneratedCover || !!ctx.input.generateCover
  const prerollSec = willHaveCover ? clampCoverDurationSec(ctx.input.coverDurationSec) : 0
  const narrationSpeed = clampBoundaryNarrationSpeed(ctx.input.boundaryNarrationSpeed)

  // Pass 1 — assemble all episodes. The `preGeneratedCover` (if any) is
  // baked into the cover preroll directly. Otherwise, we capture episode
  // 1's id so we can render the cover from it and patch every episode
  // afterwards.
  let firstCompositionId: string | null = null

  for (let i = 0; i < buckets.length; i++) {
    checkAbort(ctx.options.signal)
    const bucket = buckets[i]!
    emit(ctx, {
      stage: 'applying-highlights',
      message: `Building episode ${bucket.episodeIndex}/${N} compound...`,
      segmentTotal: N,
      segmentIndex: bucket.episodeIndex,
      fraction: N > 0 ? bucket.episodeIndex / N : 0,
    })

    const episodeSegments = bucket.segmentIndices.map((idx) => segments[idx]!)
    const episode: EpisodeAssemblyContext = {
      episodeIndex: bucket.episodeIndex,
      episodeTotal: N,
      parentSpoilerRunId,
      includesOpening: bucket.includesOpening,
      includesClosing: bucket.includesClosing,
      openingText: boundaries.openings.get(bucket.episodeIndex)?.text ?? null,
      closingText: boundaries.closings.get(bucket.episodeIndex)?.text ?? null,
      openingNarration: boundaries.openings.get(bucket.episodeIndex)
        ? {
            mediaId: boundaries.openings.get(bucket.episodeIndex)!.mediaId,
            blobUrl: boundaries.openings.get(bucket.episodeIndex)!.blobUrl,
            durationSec: boundaries.openings.get(bucket.episodeIndex)!.durationSec,
          }
        : null,
      closingNarration: boundaries.closings.get(bucket.episodeIndex)
        ? {
            mediaId: boundaries.closings.get(bucket.episodeIndex)!.mediaId,
            blobUrl: boundaries.closings.get(bucket.episodeIndex)!.blobUrl,
            durationSec: boundaries.closings.get(bucket.episodeIndex)!.durationSec,
          }
        : null,
      // Bake pre-generated cover into Pass 1; rendered cover is patched in
      // Pass 2 below (cover stays null here for that path).
      cover: preGeneratedCover ?? null,
      coverDurationSec: prerollSec,
      narrationSpeed,
    }

    const result = assembleSingleCompound({
      name: `Episode ${bucket.episodeIndex} - ${baseTitle}`,
      sourceMedia: ctx.sourceMedia,
      sourceMediaId: ctx.input.mediaId,
      sourceBlobUrl: ctx.sourceBlobUrl,
      sourceThumbnailUrl: null,
      segments: episodeSegments,
      ttsResults,
      narrationMediaById,
      narrationTranscriptsById,
      fps: ctx.fps,
      canvasWidth: ctx.canvasWidth,
      canvasHeight: ctx.canvasHeight,
      insertSubtitles: ctx.input.addSubtitles,
      ...(typeof ctx.input.wordsPerCaption === 'number'
        ? { wordsPerCaption: ctx.input.wordsPerCaption }
        : {}),
      includeOriginalAudio: ctx.input.includeOriginalAudio,
      metadataContext: {
        voiceId: ctx.input.voicePreset ?? null,
        speed: ctx.input.voiceSpeed ?? 1,
        language: ctx.input.narrationLanguage,
        scriptTitle: baseTitle,
        ...(script.synopsis ? { scriptSynopsis: script.synopsis } : {}),
        addSubtitles: ctx.input.addSubtitles,
        ...(typeof ctx.input.wordsPerCaption === 'number'
          ? { wordsPerCaption: ctx.input.wordsPerCaption }
          : {}),
        generateCover: ctx.input.generateCover,
        includeOriginalAudio: ctx.input.includeOriginalAudio,
      },
      episode,
    })

    if (!result.compositionId) {
      throw new Error(`Failed to assemble episode ${bucket.episodeIndex}.`)
    }

    if (i === 0) firstCompositionId = result.compositionId

    compositionIds.push(result.compositionId)
    totalDurationFrames += result.totalDurationFrames
    segmentsPlaced += result.segmentsPlaced
  }

  // Pass 2 — apply the cover image to every episode's opening window.
  // Source priority:
  //   1. Pre-generated AI cover from the dialog (already persisted) — preferred
  //      because the user explicitly designed it.
  //   2. Render from episode 1 (legacy fallback) when generateCover is on.
  //   3. Skip cover entirely otherwise.
  let resolvedCover: BoundaryCoverMedia | null = preGeneratedCover
  let coverWasBakedInPass1 = !!preGeneratedCover
  if (!resolvedCover && ctx.input.generateCover && firstCompositionId) {
    emit(ctx, {
      stage: 'inserting-cover',
      message: 'Generating shared episode cover...',
    })
    resolvedCover = await renderAndPersistEpisodeCover(firstCompositionId)
    coverWasBakedInPass1 = false
  }

  // Only patch when the cover was rendered AFTER Pass 1. Pre-generated
  // covers are already baked into the cover preroll window during Pass 1
  // assembly, so re-adding here would duplicate the image item.
  if (resolvedCover && !coverWasBakedInPass1) {
    const prerollFrames = Math.max(1, Math.round(prerollSec * ctx.fps))
    patchAllEpisodesWithCover({
      compositionIds,
      cover: resolvedCover,
      coverPrerollFrames: prerollFrames,
    })
  } else if (resolvedCover && coverWasBakedInPass1) {
    // Stamp metadata for sibling episodes (cover image already there).
    const compStore = useCompositionsStore.getState()
    for (const id of compositionIds) {
      const comp = compStore.getComposition(id)
      if (!comp) continue
      compStore.updateComposition(id, {
        spoilerMetadata: comp.spoilerMetadata
          ? { ...comp.spoilerMetadata, coverFrameMediaId: resolvedCover.frameMediaId }
          : comp.spoilerMetadata,
      })
    }
  }

  return { compositionIds, totalDurationFrames, segmentsPlaced, cover: resolvedCover }
}

/**
 * Compute boundary frame ranges for each compound and append a cover image
 * item to each one's "Spoiler Boundary" track.
 */
function patchAllEpisodesWithCover(args: {
  compositionIds: readonly string[]
  cover: BoundaryCoverMedia
  /**
   * Frames reserved for the cover preroll at the head of every episode.
   * Mirrors `episode.coverDurationSec * fps` from Pass 1. The cover image
   * is placed at `[0, coverPrerollFrames)` on the boundary track.
   */
  coverPrerollFrames: number
}): void {
  const compStore = useCompositionsStore.getState()
  for (let i = 0; i < args.compositionIds.length; i++) {
    const compositionId = args.compositionIds[i]!
    const comp = compStore.getComposition(compositionId)
    if (!comp) continue

    if (args.coverPrerollFrames <= 0) {
      // No preroll slot was reserved — only stamp metadata so downstream
      // UI knows this episode shares the cover.
      compStore.updateComposition(compositionId, {
        spoilerMetadata: comp.spoilerMetadata
          ? { ...comp.spoilerMetadata, coverFrameMediaId: args.cover.frameMediaId }
          : comp.spoilerMetadata,
      })
      continue
    }

    patchCompoundCoverBoundaries({
      compositionId,
      cover: args.cover,
      windows: [
        {
          from: 0,
          durationInFrames: args.coverPrerollFrames,
          label: `Cover`,
        },
      ],
    })
  }
}

async function buildNarrationMediaMap(
  ctx: PipelineContext,
  ttsResults: readonly TtsBatchOutcome[],
): Promise<Map<number, { mediaId: string; blobUrl: string; durationSec: number }>> {
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
  return narrationMediaById
}

async function stageInsertCover(
  ctx: PipelineContext,
  script: SpoilerScript,
  compositionId: string | null,
): Promise<void> {
  if (!compositionId) return

  const pre = resolvePreGeneratedCover(ctx)
  if (pre) {
    emit(ctx, { stage: 'inserting-cover', message: 'Inserting AI cover...' })
    try {
      // AI-generated posters bake the title into the image, so leave
      // primary/secondary text empty (mirrors AddCoverDialog's AI path).
      insertCover({
        compositionId,
        durationSec: clampCoverDurationSec(ctx.input.coverDurationSec),
        frameMediaId: pre.frameMediaId,
        frameSrc: pre.frameSrc,
        frameWidth: pre.frameWidth,
        frameHeight: pre.frameHeight,
        primary: '',
      })
      stampCoverMediaId(compositionId, pre.frameMediaId)
    } catch (err) {
      logger.warn('AI cover insertion failed; spoiler completes without cover.', err)
    }
    return
  }

  if (!ctx.input.generateCover) return
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
    stampCoverMediaId(compositionId, persisted.id)
  } catch (err) {
    logger.warn('Cover insertion failed; spoiler completes without cover.', err)
  }
}

/**
 * Insert a 4-second cover card at the start of the full-duration spoiler
 * compound (Episode Mode's "Full - {title}" output). Reuses the resolved
 * `BoundaryCoverMedia` from the episode loop when available so all
 * compounds share a single asset; otherwise renders a fresh frame.
 */
async function applyCoverToFullCompound(
  ctx: PipelineContext,
  script: SpoilerScript,
  compositionId: string,
  episodeCover: BoundaryCoverMedia | null,
): Promise<void> {
  if (episodeCover) {
    emit(ctx, { stage: 'inserting-cover', message: 'Inserting cover into full compound...' })
    try {
      insertCover({
        compositionId,
        durationSec: clampCoverDurationSec(ctx.input.coverDurationSec),
        frameMediaId: episodeCover.frameMediaId,
        frameSrc: episodeCover.frameSrc,
        frameWidth: episodeCover.frameWidth,
        frameHeight: episodeCover.frameHeight,
        // AI cover already has its own typography; render-from-frame
        // covers don't, so fall back to script title text in that case.
        primary: ctx.input.preGeneratedCover ? '' : script.title || 'Spoiler',
        ...(!ctx.input.preGeneratedCover && script.synopsis
          ? { secondary: truncate(script.synopsis, 80) }
          : {}),
      })
      stampCoverMediaId(compositionId, episodeCover.frameMediaId)
    } catch (err) {
      logger.warn('Cover insertion into full compound failed.', err)
    }
    return
  }

  if (!ctx.input.generateCover) return
  await stageInsertCover(ctx, script, compositionId)
}

function stampCoverMediaId(compositionId: string, mediaId: string): void {
  const compStore = useCompositionsStore.getState()
  const comp = compStore.getComposition(compositionId)
  if (!comp || !comp.spoilerMetadata) return
  compStore.updateComposition(compositionId, {
    spoilerMetadata: { ...comp.spoilerMetadata, coverFrameMediaId: mediaId },
  })
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

    const ttsSummary = summarizeBatch(ttsResults)
    const totalDurationSec = segments.reduce((acc, s) => acc + s.finalDurationSec, 0)

    if (input.episodeMode) {
      const buckets = stagePlanEpisodes(ctx, segments)
      const boundaries = await stageGenerateEpisodeNarration(ctx, buckets, projectId)
      const parentSpoilerRunId = crypto.randomUUID()
      const preGeneratedCover = resolvePreGeneratedCover(ctx)
      const assembled = await assembleEpisodesLoop(
        ctx,
        script,
        segments,
        ttsResults,
        narrationTranscripts,
        buckets,
        boundaries,
        parentSpoilerRunId,
        preGeneratedCover,
      )

      // Always also produce a single full-duration spoiler compound so the
      // user has both the per-episode breakdown AND a continuous cut to
      // pick from in the compositions panel. Cover (if any) is shared.
      const baseTitle = script.title || 'Spoiler'
      const fullName = `Full - ${baseTitle}`
      const fullAssembled = await stageAssembleCompound(
        ctx,
        script,
        segments,
        ttsResults,
        narrationTranscripts,
        {
          nameOverride: fullName,
          progressMessage: 'Building full-spoiler compound...',
        },
      )

      if (fullAssembled.compositionId) {
        await applyCoverToFullCompound(ctx, script, fullAssembled.compositionId, assembled.cover)
      }

      const totalCompounds = assembled.compositionIds.length + (fullAssembled.compositionId ? 1 : 0)

      options.onProgress({
        stage: 'done',
        message: `Spoiler ready! ${totalCompounds} compounds available in the compositions panel (${assembled.compositionIds.length} episodes + 1 full).`,
      })

      await runCleanup(ctx)

      return {
        // For the legacy single-id field, return the first episode's id —
        // callers in episode mode should inspect the compositions store
        // directly (or read `parentSpoilerRunId` from each compound's metadata).
        compositionId: assembled.compositionIds[0] ?? fullAssembled.compositionId ?? '',
        segmentsRequested: script.segments.length,
        segmentsApplied: assembled.segmentsPlaced,
        narrationsGenerated: ttsSummary.succeeded,
        narrationsFailed: ttsSummary.failed,
        totalDurationSec,
      }
    }

    const assembled = await stageAssembleCompound(
      ctx,
      script,
      segments,
      ttsResults,
      narrationTranscripts,
    )
    await stageInsertCover(ctx, script, assembled.compositionId)

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
