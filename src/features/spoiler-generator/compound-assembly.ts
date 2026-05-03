/**
 * Compound assembly — turns the validated script + TTS narration audio into
 * a single compound clip on the timeline.
 *
 * Track layout produced inside the compound (top → bottom):
 *   1. Spoiler Subtitles      — text items (when `insertSubtitles`)
 *   2. Spoiler Video          — source film slices, embedded audio MUTED
 *   3. Spoiler Original Audio — source film slices @ -18 dB (the duck level)
 *   4. Spoiler Narration      — TTS narration @ 0 dB
 *
 * Splitting the source film's audio onto its own track lets the user adjust
 * the original-audio bed independently from the narrator. Without this the
 * original audio rides on the video item's `volume` field and is invisible
 * to the volume mixer.
 *
 * Subtitle items use shared word-grouping + styling helpers (`buildSubtitleTextItem`,
 * `subdivideSegmentIntoWordGroups`) so the look matches Highlight Finder.
 */

import type { MediaTranscriptSegment, MediaMetadata } from '@/types/storage'
import type {
  AudioItem,
  ImageItem,
  TextItem,
  TimelineItem,
  TimelineTrack,
  VideoItem,
} from '@/types/timeline'
import {
  DEFAULT_TRACK_HEIGHT,
  type SubComposition,
  addItems,
  createPreComp,
  useCompositionsStore,
  useItemsStore,
  useTimelineSettingsStore,
} from './deps/timeline'
import { buildSubtitleTextItem, subdivideSegmentIntoWordGroups } from './deps/media-library'
import type { SpoilerCompositionMetadata, TtsBatchOutcome } from './types'

/**
 * Original-film audio level (dB) when overlaid under TTS narration. -18 dB
 * is loud enough for the viewer to hear ambient music + sfx but quiet
 * enough that the narrator stays clearly intelligible — same level used by
 * podcast / video-essay editors for "narration-over-bed" mixing.
 */
const ORIGINAL_AUDIO_DUCK_DB = -18

/** Default font size (px) for the boundary "Episode {n}" text overlay. */
const BOUNDARY_TEXT_FONT_SIZE = 96

/**
 * Episode-mode assembly context. When present, {@link assembleSingleCompound}
 * builds a compound with up to four ordered phases:
 *
 *   1. **Cover preroll** (frames 0..coverFrames) — only when
 *      `coverDurationSec > 0`. Cover image alone on the boundary track. No
 *      audio, no narration, no body. The cover image is added either by this
 *      stage (when `cover` is provided) or post-assembly via the
 *      orchestrator's `patchAllEpisodesWithCover` (when the cover is rendered
 *      from episode 1 after Pass 1).
 *   2. **Opening narration window** (after preroll, if `includesOpening`) —
 *      a B-roll video taken from this episode's first segment, the opening
 *      narration audio (with `narrationSpeed` applied client-side), and the
 *      "Episode {n}" text overlay.
 *   3. **Body** — script segments, each with its own narration + (optional)
 *      original-audio + subtitles.
 *   4. **Closing narration window** (if `includesClosing`) — B-roll
 *      continuation taken from the source film just after the last segment's
 *      `sourceEndSec`, the closing narration audio (with `narrationSpeed`
 *      applied), and the "Lanjutkan ke episode {next}" text overlay.
 *
 * The compound is registered directly to the compositions store via
 * `registerCompoundOnly` (no wrapper item is placed on the root timeline)
 * and `SpoilerCompositionMetadata` is stamped with v2 fields.
 */
export interface EpisodeAssemblyContext {
  /** 1-based episode number. */
  episodeIndex: number
  /** Total episodes produced in this run. */
  episodeTotal: number
  /** Correlation id shared by all sibling episodes. */
  parentSpoilerRunId: string
  /** Whether this episode begins with a TTS opening line. */
  includesOpening: boolean
  /** Whether this episode ends with a TTS closing line. */
  includesClosing: boolean
  /** Already-substituted opening text. Null when {@link includesOpening} is false. */
  openingText: string | null
  /** Already-substituted closing text. Null when {@link includesClosing} is false. */
  closingText: string | null
  /** Synthesized opening TTS audio (already imported into the media library). */
  openingNarration: BoundaryNarrationMedia | null
  /** Synthesized closing TTS audio (already imported into the media library). */
  closingNarration: BoundaryNarrationMedia | null
  /**
   * Cover image asset shared across all sibling episodes. When null, no
   * cover image is rendered during the cover preroll window — the
   * orchestrator may still patch one in afterwards via
   * `patchAllEpisodesWithCover`. The opening narration window NEVER carries
   * a cover image (B-roll plays under the narration instead).
   */
  cover: BoundaryCoverMedia | null
  /**
   * Length of the cover preroll window in seconds. When > 0 and either
   * `cover` is present or the orchestrator plans to patch one in,
   * frames 0..coverFrames hold the cover image alone. Set to 0 to skip the
   * preroll (opening narration starts at frame 0).
   */
  coverDurationSec: number
  /**
   * Client-side playback rate applied to the opening + closing narration
   * audio items via the AudioItem `speed` field. Range typically `[0.5, 4]`.
   * `1` = no change. Higher values shorten the boundary window proportionally
   * because the audio is consumed faster on the timeline.
   */
  narrationSpeed: number
}

export interface BoundaryNarrationMedia {
  mediaId: string
  blobUrl: string
  durationSec: number
}

export interface BoundaryCoverMedia {
  frameMediaId: string
  frameSrc: string
  frameWidth: number
  frameHeight: number
}

export interface AssembleSegmentInput {
  /** 0-based ordering. */
  index: number
  /** Source-media seconds — start of the clip range. */
  sourceStartSec: number
  /** Source-media seconds — end of the clip range. */
  sourceEndSec: number
  /** Narration text — used as fallback subtitle when transcript is unavailable. */
  narration: string
  /**
   * Final clip duration on the spoiler timeline (seconds). Should match the
   * narration audio duration when TTS succeeded; otherwise the segment's
   * source duration. Computed by the orchestrator's sync stage.
   */
  finalDurationSec: number
}

export interface AssembleSingleCompoundParams {
  /** Compound clip name (e.g. spoiler title). */
  name: string
  /** Source film media metadata (already loaded from media library). */
  sourceMedia: MediaMetadata
  /** Source film media id. */
  sourceMediaId: string
  /** Object URL pointing at the source film blob (timeline `src` field). */
  sourceBlobUrl: string
  /** Optional thumbnail URL for the source film. */
  sourceThumbnailUrl?: string | null
  /** Per-segment plan derived from validated script + TTS results. */
  segments: readonly AssembleSegmentInput[]
  /**
   * TTS audio per segment. Length must match `segments`. Failures (where
   * `outcome.error` is set) are skipped — the assembler still produces a
   * silent video segment for them.
   */
  ttsResults: readonly TtsBatchOutcome[]
  /** Saved narration media metadata, indexed by segment.index. */
  narrationMediaById: ReadonlyMap<number, { mediaId: string; blobUrl: string; durationSec: number }>
  /**
   * Word-level transcripts of the TTS narration audio, indexed by
   * `segment.index`. When present, used to drive per-word subtitle timing.
   * Missing entries fall back to a single subtitle item per segment.
   */
  narrationTranscriptsById?: ReadonlyMap<number, readonly MediaTranscriptSegment[]>
  /** Project FPS at assembly time. */
  fps: number
  /** Project canvas dimensions. */
  canvasWidth: number
  canvasHeight: number
  /** Whether to insert subtitle text items per segment. */
  insertSubtitles: boolean
  /**
   * Words per subtitle text item. Only consulted when
   * `insertSubtitles === true`. Defaults to `1` (karaoke).
   */
  wordsPerCaption?: number
  /**
   * When false, the dedicated "Spoiler Original Audio" track is omitted —
   * only the narration audio is mounted. Defaults to true. Tradeoff: with the
   * track off, the user can't rebalance original-audio independently from
   * narration.
   */
  includeOriginalAudio?: boolean
  /**
   * Optional generation context to stamp onto the resulting `SubComposition`
   * as `spoilerMetadata`. Powers the "Regenerate Narration…" right-click
   * action. When omitted (e.g. tests), the compound is still created without
   * the metadata field.
   */
  metadataContext?: {
    voiceId: string | null
    speed: number
    language: string
    scriptTitle: string
    scriptSynopsis?: string
    addSubtitles: boolean
    wordsPerCaption?: number
    generateCover: boolean
    includeOriginalAudio: boolean
  }
  /**
   * When provided, the compound is built in Episode Mode: opening/closing
   * boundary tracks + items are emitted, and the compound is registered to
   * the compositions store directly (no root-timeline wrapper). The metadata
   * stamp uses v2 with episode-specific fields populated.
   */
  episode?: EpisodeAssemblyContext
}

export interface AssembleSingleCompoundResult {
  /** SubComposition id of the resulting compound clip. */
  compositionId: string | null
  /** Total duration of the compound in project frames. */
  totalDurationFrames: number
  /** How many video segments were placed. */
  segmentsPlaced: number
}

/**
 * Per-segment id mapping returned by {@link buildItemsForAssembly}. Used to
 * stamp `spoilerMetadata.segments` on the resulting compound so the regen
 * action can locate items in place.
 */
interface BuiltSegmentIds {
  index: number
  narrationItemId: string
  videoItemId: string
  originalAudioItemId: string | null
  subtitleItemIds: string[]
  sourceClipRange: { start: number; end: number }
  /** Narration text fed into TTS for this segment — preserved for regen. */
  narrationText: string
}

interface BuiltItems {
  videoItems: VideoItem[]
  audioItems: AudioItem[]
  textItems: TextItem[]
  imageItems: ImageItem[]
  totalDurationFrames: number
  newTracks: TimelineTrack[]
  segmentIds: BuiltSegmentIds[]
  /** AudioItem id of the opening narration. Null when not in episode mode or no opening. */
  openingNarrationItemId: string | null
  /** AudioItem id of the closing narration. Null when not in episode mode or no closing. */
  closingNarrationItemId: string | null
}

function buildBaseTrack(name: string, order: number, kind: 'video' | 'audio'): TimelineTrack {
  return {
    id: crypto.randomUUID(),
    name,
    kind,
    height: DEFAULT_TRACK_HEIGHT,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order,
    items: [],
  }
}

/**
 * Clamp the boundary narration speed multiplier to a sensible range. `1`
 * (no scaling) is used when the value is missing or invalid.
 */
function clampNarrationSpeed(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 1
  return Math.max(0.25, Math.min(4, value))
}

/**
 * Compute the cover preroll length (in project frames) from the episode
 * context. Returns `0` when the episode has no preroll requirement
 * (`coverDurationSec <= 0` or no episode context). Used to reserve a leading
 * window where the cover image plays alone before the opening narration.
 */
function computeCoverPrerollFrames(params: AssembleSingleCompoundParams): number {
  const ep = params.episode
  if (!ep) return 0
  const sec = ep.coverDurationSec
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return 0
  return Math.max(1, Math.round(sec * params.fps))
}

function buildSubtitleItemsForSegment(params: {
  trackId: string
  segment: AssembleSegmentInput
  cursorFrame: number
  segmentDurationFrames: number
  fps: number
  canvasWidth: number
  canvasHeight: number
  transcript: readonly MediaTranscriptSegment[] | undefined
  wordsPerCaption?: number
}): TextItem[] {
  const {
    trackId,
    segment,
    cursorFrame,
    segmentDurationFrames,
    fps,
    canvasWidth,
    canvasHeight,
    transcript,
    wordsPerCaption = 1,
  } = params

  // Fallback path: no transcript (provider didn't return word timing, or the
  // narration transcription failed). Synthesize chunk timing from the
  // narration text + segment duration via the chunker. For wordsPerCaption=1
  // this is karaoke; for higher N it groups N text tokens per item with
  // approximate timing.
  if (!transcript || transcript.length === 0) {
    const text = segment.narration.trim()
    if (!text) return []
    const segmentEndFrame = cursorFrame + segmentDurationFrames
    const segmentDurationSec = segmentDurationFrames / fps
    const synthChunks = subdivideSegmentIntoWordGroups(
      { text, start: 0, end: segmentDurationSec },
      wordsPerCaption,
    )
    return synthChunks.map((chunk) => {
      const fromFrame = cursorFrame + Math.max(0, Math.round(chunk.start * fps))
      const endFrame = cursorFrame + Math.max(1, Math.round(chunk.end * fps))
      const clampedFrom = Math.min(fromFrame, segmentEndFrame - 1)
      const clampedEnd = Math.min(Math.max(clampedFrom + 1, endFrame), segmentEndFrame)
      const durationInFrames = Math.max(1, clampedEnd - clampedFrom)
      return buildSubtitleTextItem({
        trackId,
        from: clampedFrom,
        durationInFrames,
        text: chunk.text,
        canvasWidth,
        canvasHeight,
      })
    })
  }

  const segmentEndFrame = cursorFrame + segmentDurationFrames
  const items: TextItem[] = []

  for (const seg of transcript) {
    const chunks = subdivideSegmentIntoWordGroups(
      {
        text: seg.text,
        start: seg.start,
        end: seg.end,
        ...(seg.words ? { words: [...seg.words] } : {}),
      },
      wordsPerCaption,
    )
    for (const chunk of chunks) {
      const text = chunk.text.trim()
      if (!text) continue
      const fromFrame = cursorFrame + Math.max(0, Math.round(chunk.start * fps))
      const endFrame = cursorFrame + Math.max(1, Math.round(chunk.end * fps))
      const clampedFrom = Math.min(fromFrame, segmentEndFrame - 1)
      const clampedEnd = Math.min(Math.max(clampedFrom + 1, endFrame), segmentEndFrame)
      const durationInFrames = Math.max(1, clampedEnd - clampedFrom)
      items.push(
        buildSubtitleTextItem({
          trackId,
          from: clampedFrom,
          durationInFrames,
          text,
          canvasWidth,
          canvasHeight,
        }),
      )
    }
  }

  return items
}

function buildItemsForAssembly(params: AssembleSingleCompoundParams): BuiltItems {
  const sourceFps = params.sourceMedia.fps || params.fps
  const sourceDurationFrames = Math.max(1, Math.round(params.sourceMedia.duration * sourceFps))
  const includeOriginalAudio = params.includeOriginalAudio ?? true

  const itemsState = useItemsStore.getState()
  const minOrder = itemsState.tracks.reduce((acc, t) => Math.min(acc, t.order), 0)
  const baseOrder = minOrder - 1
  // Order: subtitles (top) → boundary → video → original audio → narration (bottom).
  // Boundary sits above video so its image+text overlay during opening/closing
  // windows draws on top when both are present (segments are absent in those
  // windows but the layering is consistent).
  const videoTrack = buildBaseTrack('Spoiler Video', baseOrder, 'video')
  const coverPrerollFrames = computeCoverPrerollFrames(params)
  const needBoundaryTrack =
    !!params.episode?.includesOpening || !!params.episode?.includesClosing || coverPrerollFrames > 0
  const boundaryTrack = needBoundaryTrack
    ? buildBaseTrack('Spoiler Boundary', baseOrder - 0.05, 'video')
    : null
  const originalAudioTrack = includeOriginalAudio
    ? buildBaseTrack('Spoiler Original Audio', baseOrder + 0.1, 'audio')
    : null
  const narrationTrack = buildBaseTrack('Spoiler Narration', baseOrder + 0.2, 'audio')
  const subtitleTrack = params.insertSubtitles
    ? buildBaseTrack('Spoiler Subtitles', baseOrder - 0.1, 'video')
    : null

  const videoItems: VideoItem[] = []
  const audioItems: AudioItem[] = []
  const textItems: TextItem[] = []
  const imageItems: ImageItem[] = []
  const segmentIds: BuiltSegmentIds[] = []

  let cursorFrame = 0
  let openingNarrationItemId: string | null = null
  let closingNarrationItemId: string | null = null

  // Phase 1 — Cover preroll. Cover image alone, no audio or B-roll.
  // The image is added here when `cover` is already known (preGeneratedCover
  // path). When `cover === null`, the orchestrator will patch one in via
  // `patchAllEpisodesWithCover` after rendering from episode 1.
  if (coverPrerollFrames > 0 && boundaryTrack) {
    if (params.episode?.cover) {
      imageItems.push(
        buildBoundaryCoverImage({
          trackId: boundaryTrack.id,
          from: cursorFrame,
          durationInFrames: coverPrerollFrames,
          cover: params.episode.cover,
          label: `Episode ${params.episode.episodeIndex} Cover`,
        }),
      )
    }
    cursorFrame += coverPrerollFrames
  }

  // Phase 2 — Opening narration window. Random B-roll from the first body
  // segment plays under the narration audio + "Episode {n}" text overlay.
  // The boundary audio item carries `speed=narrationSpeed` so the user can
  // accelerate slow TTS output without depending on the provider honoring
  // the server-side speed parameter.
  if (params.episode?.includesOpening && params.episode.openingNarration && boundaryTrack) {
    const opening = params.episode.openingNarration
    const narrationSpeed = clampNarrationSpeed(params.episode.narrationSpeed)
    const openingDurationFrames = Math.max(
      1,
      Math.round((opening.durationSec / narrationSpeed) * params.fps),
    )
    const text = params.episode.openingText ?? `Episode ${params.episode.episodeIndex}`

    const firstSegment = params.segments[0]
    if (firstSegment) {
      const brollSourceStartSec = Math.max(
        0,
        Math.min(params.sourceMedia.duration - 0.001, firstSegment.sourceStartSec),
      )
      const brollSourceEndSec = Math.min(
        params.sourceMedia.duration,
        brollSourceStartSec + openingDurationFrames / params.fps,
      )
      const brollSourceStartNative = Math.max(
        0,
        Math.min(sourceDurationFrames - 1, Math.round(brollSourceStartSec * sourceFps)),
      )
      const brollSourceEndNative = Math.max(
        brollSourceStartNative + 1,
        Math.min(sourceDurationFrames, Math.round(brollSourceEndSec * sourceFps)),
      )

      videoItems.push({
        id: crypto.randomUUID(),
        type: 'video',
        trackId: videoTrack.id,
        from: cursorFrame,
        durationInFrames: openingDurationFrames,
        label: `Episode ${params.episode.episodeIndex} Opening B-roll`,
        mediaId: params.sourceMediaId,
        originId: crypto.randomUUID(),
        src: params.sourceBlobUrl,
        thumbnailUrl: params.sourceThumbnailUrl || undefined,
        sourceStart: brollSourceStartNative,
        sourceEnd: brollSourceEndNative,
        sourceDuration: sourceDurationFrames,
        sourceFps,
        trimStart: 0,
        trimEnd: 0,
        sourceWidth: params.sourceMedia.width || undefined,
        sourceHeight: params.sourceMedia.height || undefined,
        transform: { x: 0, y: 0, rotation: 0, opacity: 1 },
        embeddedAudioMuted: true,
      } as VideoItem)

      if (originalAudioTrack) {
        audioItems.push({
          id: crypto.randomUUID(),
          type: 'audio',
          trackId: originalAudioTrack.id,
          from: cursorFrame,
          durationInFrames: openingDurationFrames,
          label: `Episode ${params.episode.episodeIndex} Opening Audio Bed`,
          mediaId: params.sourceMediaId,
          originId: crypto.randomUUID(),
          src: params.sourceBlobUrl,
          sourceStart: brollSourceStartNative,
          sourceEnd: brollSourceEndNative,
          sourceDuration: sourceDurationFrames,
          sourceFps,
          trimStart: 0,
          trimEnd: 0,
          volume: ORIGINAL_AUDIO_DUCK_DB,
        } as AudioItem)
      }
    }

    textItems.push(
      buildBoundaryText({
        trackId: boundaryTrack.id,
        from: cursorFrame,
        durationInFrames: openingDurationFrames,
        text,
        canvasWidth: params.canvasWidth,
        canvasHeight: params.canvasHeight,
      }),
    )

    const openingNaturalFrames = Math.max(1, Math.round(opening.durationSec * params.fps))
    const openingAudio: AudioItem = {
      id: crypto.randomUUID(),
      type: 'audio',
      trackId: narrationTrack.id,
      from: cursorFrame,
      durationInFrames: openingDurationFrames,
      speed: narrationSpeed,
      label: `Episode ${params.episode.episodeIndex} Opening`,
      mediaId: opening.mediaId,
      originId: crypto.randomUUID(),
      src: opening.blobUrl,
      sourceStart: 0,
      sourceEnd: openingNaturalFrames,
      sourceDuration: openingNaturalFrames,
      sourceFps: params.fps,
      trimStart: 0,
      trimEnd: 0,
    } as AudioItem
    audioItems.push(openingAudio)
    openingNarrationItemId = openingAudio.id

    cursorFrame += openingDurationFrames
  }

  for (const segment of params.segments) {
    const segmentDurationFrames = Math.max(1, Math.round(segment.finalDurationSec * params.fps))

    const sourceStartNative = Math.max(
      0,
      Math.min(sourceDurationFrames - 1, Math.round(segment.sourceStartSec * sourceFps)),
    )
    const sourceFramesForClip = Math.max(
      1,
      Math.round((segmentDurationFrames * sourceFps) / params.fps),
    )
    const sourceEndNative = Math.min(sourceDurationFrames, sourceStartNative + sourceFramesForClip)

    const videoItem: VideoItem = {
      id: crypto.randomUUID(),
      type: 'video',
      trackId: videoTrack.id,
      from: cursorFrame,
      durationInFrames: segmentDurationFrames,
      label: `Spoiler Segment ${segment.index + 1}`,
      mediaId: params.sourceMediaId,
      originId: crypto.randomUUID(),
      src: params.sourceBlobUrl,
      thumbnailUrl: params.sourceThumbnailUrl || undefined,
      sourceStart: sourceStartNative,
      sourceEnd: sourceEndNative,
      sourceDuration: sourceDurationFrames,
      sourceFps,
      trimStart: 0,
      trimEnd: 0,
      sourceWidth: params.sourceMedia.width || undefined,
      sourceHeight: params.sourceMedia.height || undefined,
      transform: { x: 0, y: 0, rotation: 0, opacity: 1 },
      // Embedded audio is muted because we mount a dedicated audio item on
      // the Original Audio track for this same range — playing both would
      // double the original film audio. When the original-audio track is
      // off (`includeOriginalAudio === false`), keep the embedded audio
      // muted too: the user explicitly opted out of the original soundtrack.
      embeddedAudioMuted: true,
    } as VideoItem
    videoItems.push(videoItem)

    let originalAudioItemId: string | null = null
    if (originalAudioTrack) {
      const originalAudioItem: AudioItem = {
        id: crypto.randomUUID(),
        type: 'audio',
        trackId: originalAudioTrack.id,
        from: cursorFrame,
        durationInFrames: segmentDurationFrames,
        label: `Original Audio ${segment.index + 1}`,
        mediaId: params.sourceMediaId,
        originId: crypto.randomUUID(),
        src: params.sourceBlobUrl,
        sourceStart: sourceStartNative,
        sourceEnd: sourceEndNative,
        sourceDuration: sourceDurationFrames,
        sourceFps,
        trimStart: 0,
        trimEnd: 0,
        // -18 dB ducks the original under the narrator. User can rebalance
        // freely from the track-level volume slider.
        volume: ORIGINAL_AUDIO_DUCK_DB,
      } as AudioItem
      audioItems.push(originalAudioItem)
      originalAudioItemId = originalAudioItem.id
    }

    let narrationItemId = ''
    const narrationMedia = params.narrationMediaById.get(segment.index)
    if (narrationMedia) {
      const narrationDurationFrames = Math.max(
        1,
        Math.round(narrationMedia.durationSec * params.fps),
      )
      const narrationItem: AudioItem = {
        id: crypto.randomUUID(),
        type: 'audio',
        trackId: narrationTrack.id,
        from: cursorFrame,
        durationInFrames: Math.min(narrationDurationFrames, segmentDurationFrames),
        label: `Narration ${segment.index + 1}`,
        mediaId: narrationMedia.mediaId,
        originId: crypto.randomUUID(),
        src: narrationMedia.blobUrl,
        sourceStart: 0,
        sourceEnd: narrationDurationFrames,
        sourceDuration: narrationDurationFrames,
        sourceFps: params.fps,
        trimStart: 0,
        trimEnd: 0,
      } as AudioItem
      audioItems.push(narrationItem)
      narrationItemId = narrationItem.id
    }

    const segmentSubtitleIds: string[] = []
    if (params.insertSubtitles && subtitleTrack) {
      const segmentSubtitles = buildSubtitleItemsForSegment({
        trackId: subtitleTrack.id,
        segment,
        cursorFrame,
        segmentDurationFrames,
        fps: params.fps,
        canvasWidth: params.canvasWidth,
        canvasHeight: params.canvasHeight,
        transcript: params.narrationTranscriptsById?.get(segment.index),
        ...(typeof params.wordsPerCaption === 'number'
          ? { wordsPerCaption: params.wordsPerCaption }
          : {}),
      })
      textItems.push(...segmentSubtitles)
      for (const item of segmentSubtitles) segmentSubtitleIds.push(item.id)
    }

    segmentIds.push({
      index: segment.index,
      narrationItemId,
      videoItemId: videoItem.id,
      originalAudioItemId,
      subtitleItemIds: segmentSubtitleIds,
      sourceClipRange: {
        start: segment.sourceStartSec,
        end: segment.sourceEndSec,
      },
      narrationText: segment.narration,
    })

    cursorFrame += segmentDurationFrames
  }

  // Episode closing boundary — placed after the last segment. The closing
  // window keeps a video clip playing under the CTA text so the viewer
  // doesn't see a blank screen + cover image while the narrator says
  // "lanjutkan nonton di episode {next}". The clip is a B-roll continuation
  // taken from the source film immediately after the last body segment's
  // `sourceEndSec`. When the source film is too short to cover the full
  // closing duration, we clamp to whatever source frames remain.
  if (params.episode?.includesClosing && params.episode.closingNarration && boundaryTrack) {
    const closing = params.episode.closingNarration
    const narrationSpeed = clampNarrationSpeed(params.episode.narrationSpeed)
    const closingDurationFrames = Math.max(
      1,
      Math.round((closing.durationSec / narrationSpeed) * params.fps),
    )
    const text = params.episode.closingText ?? `Episode ${params.episode.episodeIndex + 1}`

    const lastSegment = params.segments[params.segments.length - 1]
    if (lastSegment) {
      const closingSourceStartSec = Math.max(
        0,
        Math.min(params.sourceMedia.duration - 0.001, lastSegment.sourceEndSec),
      )
      const closingSourceEndSec = Math.min(
        params.sourceMedia.duration,
        closingSourceStartSec + closingDurationFrames / params.fps,
      )
      const closingSourceStartNative = Math.max(
        0,
        Math.min(sourceDurationFrames - 1, Math.round(closingSourceStartSec * sourceFps)),
      )
      const closingSourceEndNative = Math.max(
        closingSourceStartNative + 1,
        Math.min(sourceDurationFrames, Math.round(closingSourceEndSec * sourceFps)),
      )

      const closingVideoItem: VideoItem = {
        id: crypto.randomUUID(),
        type: 'video',
        trackId: videoTrack.id,
        from: cursorFrame,
        durationInFrames: closingDurationFrames,
        label: `Episode ${params.episode.episodeIndex} Closing B-roll`,
        mediaId: params.sourceMediaId,
        originId: crypto.randomUUID(),
        src: params.sourceBlobUrl,
        thumbnailUrl: params.sourceThumbnailUrl || undefined,
        sourceStart: closingSourceStartNative,
        sourceEnd: closingSourceEndNative,
        sourceDuration: sourceDurationFrames,
        sourceFps,
        trimStart: 0,
        trimEnd: 0,
        sourceWidth: params.sourceMedia.width || undefined,
        sourceHeight: params.sourceMedia.height || undefined,
        transform: { x: 0, y: 0, rotation: 0, opacity: 1 },
        embeddedAudioMuted: true,
      } as VideoItem
      videoItems.push(closingVideoItem)

      if (originalAudioTrack) {
        const closingOriginalAudio: AudioItem = {
          id: crypto.randomUUID(),
          type: 'audio',
          trackId: originalAudioTrack.id,
          from: cursorFrame,
          durationInFrames: closingDurationFrames,
          label: `Episode ${params.episode.episodeIndex} Closing Audio Bed`,
          mediaId: params.sourceMediaId,
          originId: crypto.randomUUID(),
          src: params.sourceBlobUrl,
          sourceStart: closingSourceStartNative,
          sourceEnd: closingSourceEndNative,
          sourceDuration: sourceDurationFrames,
          sourceFps,
          trimStart: 0,
          trimEnd: 0,
          volume: ORIGINAL_AUDIO_DUCK_DB,
        } as AudioItem
        audioItems.push(closingOriginalAudio)
      }
    }

    textItems.push(
      buildBoundaryText({
        trackId: boundaryTrack.id,
        from: cursorFrame,
        durationInFrames: closingDurationFrames,
        text,
        canvasWidth: params.canvasWidth,
        canvasHeight: params.canvasHeight,
      }),
    )

    const closingNaturalFrames = Math.max(1, Math.round(closing.durationSec * params.fps))
    const closingAudio: AudioItem = {
      id: crypto.randomUUID(),
      type: 'audio',
      trackId: narrationTrack.id,
      from: cursorFrame,
      durationInFrames: closingDurationFrames,
      speed: narrationSpeed,
      label: `Episode ${params.episode.episodeIndex} Closing`,
      mediaId: closing.mediaId,
      originId: crypto.randomUUID(),
      src: closing.blobUrl,
      sourceStart: 0,
      sourceEnd: closingNaturalFrames,
      sourceDuration: closingNaturalFrames,
      sourceFps: params.fps,
      trimStart: 0,
      trimEnd: 0,
    } as AudioItem
    audioItems.push(closingAudio)
    closingNarrationItemId = closingAudio.id

    cursorFrame += closingDurationFrames
  }

  const newTracks: TimelineTrack[] = []
  if (subtitleTrack) newTracks.push(subtitleTrack)
  if (boundaryTrack) newTracks.push(boundaryTrack)
  newTracks.push(videoTrack)
  if (originalAudioTrack) newTracks.push(originalAudioTrack)
  newTracks.push(narrationTrack)

  return {
    videoItems,
    audioItems,
    textItems,
    imageItems,
    totalDurationFrames: cursorFrame,
    newTracks,
    segmentIds,
    openingNarrationItemId,
    closingNarrationItemId,
  }
}

function buildBoundaryCoverImage(params: {
  trackId: string
  from: number
  durationInFrames: number
  cover: BoundaryCoverMedia
  label: string
}): ImageItem {
  return {
    id: crypto.randomUUID(),
    type: 'image',
    trackId: params.trackId,
    from: params.from,
    durationInFrames: params.durationInFrames,
    label: params.label,
    mediaId: params.cover.frameMediaId,
    originId: crypto.randomUUID(),
    src: params.cover.frameSrc,
    sourceWidth: params.cover.frameWidth,
    sourceHeight: params.cover.frameHeight,
    transform: { x: 0, y: 0, rotation: 0, opacity: 1 },
  } as ImageItem
}

function buildBoundaryText(params: {
  trackId: string
  from: number
  durationInFrames: number
  text: string
  canvasWidth: number
  canvasHeight: number
}): TextItem {
  return {
    id: crypto.randomUUID(),
    type: 'text',
    trackId: params.trackId,
    from: params.from,
    durationInFrames: params.durationInFrames,
    label: params.text,
    text: params.text,
    fontSize: BOUNDARY_TEXT_FONT_SIZE,
    fontWeight: 'bold',
    color: '#ffffff',
    backgroundColor: 'transparent',
    textAlign: 'center',
    verticalAlign: 'middle',
    textShadow: {
      offsetX: 0,
      offsetY: 4,
      blur: 16,
      color: 'rgba(0, 0, 0, 0.85)',
    },
  } as TextItem
}

/**
 * Assemble a single compound clip from script segments + TTS results.
 *
 * The function mutates the timeline via the public action API so all changes
 * are reversible (Ctrl+Z). The newly created compound's id is returned.
 *
 * In Episode Mode (when `params.episode` is provided) the compound is
 * registered directly to the compositions store WITHOUT placing a wrapper
 * item on the root timeline — the user picks each episode out of the
 * compositions panel manually.
 */
export function assembleSingleCompound(
  params: AssembleSingleCompoundParams,
): AssembleSingleCompoundResult {
  if (params.segments.length === 0) {
    return { compositionId: null, totalDurationFrames: 0, segmentsPlaced: 0 }
  }

  const built = buildItemsForAssembly(params)
  const allItems: TimelineItem[] = [
    ...built.videoItems,
    ...built.audioItems,
    ...built.textItems,
    ...built.imageItems,
  ]

  let compositionId: string | null = null

  if (params.episode) {
    // Episode mode: build a self-contained SubComposition with items already
    // anchored relative to its own t=0, then register without root placement.
    const episodeItems = allItems.map((item) => ({ ...item }))
    const registered = registerCompoundOnly({
      name: params.name,
      items: episodeItems,
      tracks: built.newTracks,
      fps: params.fps,
      width: params.canvasWidth,
      height: params.canvasHeight,
      durationInFrames: built.totalDurationFrames,
    })
    compositionId = registered.id
  } else {
    // Single-mode (legacy): mount tracks/items on root then promote into a
    // pre-comp via the existing action so we get the wrapper item too.
    const itemsStore = useItemsStore.getState()
    const nextTracks = [...itemsStore.tracks, ...built.newTracks]
    itemsStore.setTracks(nextTracks)
    useTimelineSettingsStore.getState().markDirty()

    addItems(allItems)

    const itemIds = allItems.map((i) => i.id)
    const comp = createPreComp(params.name, itemIds)
    compositionId = comp?.id ?? null
  }

  // Stamp generation metadata onto the resulting SubComposition so the
  // "Regenerate Narration…" right-click flow can locate items in place.
  // The metadata schema bumps to v2 when episode context is present so
  // future episode-aware regen flows can read sibling correlation.
  if (compositionId && params.metadataContext) {
    const ctx = params.metadataContext
    const ep = params.episode
    const metadata: SpoilerCompositionMetadata = {
      version: ep ? 2 : 1,
      generatedAt: Date.now(),
      segments: built.segmentIds.map((s) => ({
        index: s.index,
        narrationText: s.narrationText,
        narrationItemId: s.narrationItemId,
        videoItemId: s.videoItemId,
        originalAudioItemId: s.originalAudioItemId,
        subtitleItemIds: [...s.subtitleItemIds],
        sourceClipRange: { ...s.sourceClipRange },
      })),
      voiceId: ctx.voiceId,
      speed: ctx.speed,
      language: ctx.language,
      scriptTitle: ctx.scriptTitle,
      ...(ctx.scriptSynopsis !== undefined ? { scriptSynopsis: ctx.scriptSynopsis } : {}),
      addSubtitles: ctx.addSubtitles,
      ...(typeof ctx.wordsPerCaption === 'number' ? { wordsPerCaption: ctx.wordsPerCaption } : {}),
      generateCover: ctx.generateCover,
      includeOriginalAudio: ctx.includeOriginalAudio,
      sourceFilmMediaId: params.sourceMediaId,
      ...(ep
        ? {
            episodeIndex: ep.episodeIndex,
            episodeTotal: ep.episodeTotal,
            parentSpoilerRunId: ep.parentSpoilerRunId,
            episodeOpeningNarrationItemId: built.openingNarrationItemId,
            episodeClosingNarrationItemId: built.closingNarrationItemId,
            episodeOpeningText: ep.openingText,
            episodeClosingText: ep.closingText,
            coverFrameMediaId: ep.cover?.frameMediaId ?? null,
          }
        : {}),
    }
    useCompositionsStore.getState().updateComposition(compositionId, { spoilerMetadata: metadata })
  }

  return {
    compositionId,
    totalDurationFrames: built.totalDurationFrames,
    segmentsPlaced: built.videoItems.length,
  }
}

/**
 * Register a fully-built compound directly to the compositions store, with
 * NO wrapper item placed on the root timeline. Used by Episode Mode where
 * the user pulls episodes out of the compositions panel manually. Mirrors
 * the SubComposition-construction segment of `composition-actions.createPreComp`.
 */
function registerCompoundOnly(args: {
  name: string
  items: TimelineItem[]
  tracks: TimelineTrack[]
  fps: number
  width: number
  height: number
  durationInFrames: number
  backgroundColor?: string
}): { id: string } {
  const id = crypto.randomUUID()
  const subComp: SubComposition = {
    id,
    name: args.name,
    items: args.items,
    tracks: args.tracks,
    transitions: [],
    keyframes: [],
    fps: args.fps,
    width: args.width,
    height: args.height,
    durationInFrames: args.durationInFrames,
    ...(args.backgroundColor ? { backgroundColor: args.backgroundColor } : {}),
  }
  useCompositionsStore.getState().addComposition(subComp)
  useTimelineSettingsStore.getState().markDirty()
  return { id }
}

export { buildSubtitleItemsForSegment as buildSpoilerSubtitleItemsForSegment }

export const __test = { buildItemsForAssembly, buildBaseTrack, buildSubtitleItemsForSegment }
