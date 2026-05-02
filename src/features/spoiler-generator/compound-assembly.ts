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
 * `subdivideSegmentIntoWordGroups`) so the look matches Highlight Finder
 * and respects the global `defaultSubtitleGranularity` setting.
 */

import type { MediaTranscriptSegment, MediaMetadata } from '@/types/storage'
import type { AudioItem, TextItem, TimelineItem, TimelineTrack, VideoItem } from '@/types/timeline'

import {
  DEFAULT_TRACK_HEIGHT,
  addItems,
  createPreComp,
  useCompositionsStore,
  useItemsStore,
  useTimelineSettingsStore,
} from './deps/timeline'
import {
  DEFAULT_SUBTITLE_GRANULARITY,
  buildSubtitleTextItem,
  subdivideSegmentIntoWordGroups,
} from './deps/media-library'
import type { SubtitleGranularity } from './deps/settings'
import type { SpoilerCompositionMetadata, TtsBatchOutcome } from './types'

/**
 * Original-film audio level (dB) when overlaid under TTS narration. -18 dB
 * is loud enough for the viewer to hear ambient music + sfx but quiet
 * enough that the narrator stays clearly intelligible — same level used by
 * podcast / video-essay editors for "narration-over-bed" mixing.
 */
const ORIGINAL_AUDIO_DUCK_DB = -18

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
   * When false, the dedicated "Spoiler Original Audio" track is omitted —
   * only the narration audio is mounted. Defaults to true. Tradeoff: with the
   * track off, the user can't rebalance original-audio independently from
   * narration.
   */
  includeOriginalAudio?: boolean
  /**
   * Word-grouping granularity for subtitles. Defaults to
   * {@link DEFAULT_SUBTITLE_GRANULARITY} when omitted. The orchestrator
   * normally reads this from the global settings store.
   */
  subtitleGranularity?: SubtitleGranularity
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
    granularity: SubtitleGranularity
    addSubtitles: boolean
    generateCover: boolean
    includeOriginalAudio: boolean
  }
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
  totalDurationFrames: number
  newTracks: TimelineTrack[]
  segmentIds: BuiltSegmentIds[]
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

function buildSubtitleItemsForSegment(params: {
  trackId: string
  segment: AssembleSegmentInput
  cursorFrame: number
  segmentDurationFrames: number
  fps: number
  canvasWidth: number
  canvasHeight: number
  granularity: SubtitleGranularity
  transcript: readonly MediaTranscriptSegment[] | undefined
}): TextItem[] {
  const {
    trackId,
    segment,
    cursorFrame,
    segmentDurationFrames,
    fps,
    canvasWidth,
    canvasHeight,
    granularity,
    transcript,
  } = params

  // Fallback: no transcript (provider didn't return word timing, or the
  // narration transcription failed). Show the full narration text across
  // the whole segment as a single subtitle item.
  if (!transcript || transcript.length === 0) {
    const text = segment.narration.trim()
    if (!text) return []
    return [
      buildSubtitleTextItem({
        trackId,
        from: cursorFrame,
        durationInFrames: segmentDurationFrames,
        text,
        canvasWidth,
        canvasHeight,
      }),
    ]
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
      granularity,
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
  const granularity = params.subtitleGranularity ?? DEFAULT_SUBTITLE_GRANULARITY
  const includeOriginalAudio = params.includeOriginalAudio ?? true

  const itemsState = useItemsStore.getState()
  const minOrder = itemsState.tracks.reduce((acc, t) => Math.min(acc, t.order), 0)
  const baseOrder = minOrder - 1
  // Order: subtitles (top) → video → original audio → narration (bottom).
  const videoTrack = buildBaseTrack('Spoiler Video', baseOrder, 'video')
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
  const segmentIds: BuiltSegmentIds[] = []

  let cursorFrame = 0
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
        granularity,
        transcript: params.narrationTranscriptsById?.get(segment.index),
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

  const newTracks: TimelineTrack[] = []
  if (subtitleTrack) newTracks.push(subtitleTrack)
  newTracks.push(videoTrack)
  if (originalAudioTrack) newTracks.push(originalAudioTrack)
  newTracks.push(narrationTrack)

  return {
    videoItems,
    audioItems,
    textItems,
    totalDurationFrames: cursorFrame,
    newTracks,
    segmentIds,
  }
}

/**
 * Assemble a single compound clip from script segments + TTS results.
 *
 * The function mutates the timeline via the public action API so all changes
 * are reversible (Ctrl+Z). The newly created compound's id is returned.
 */
export function assembleSingleCompound(
  params: AssembleSingleCompoundParams,
): AssembleSingleCompoundResult {
  if (params.segments.length === 0) {
    return { compositionId: null, totalDurationFrames: 0, segmentsPlaced: 0 }
  }

  const built = buildItemsForAssembly(params)

  // Add the new tracks first via the items-store directly (bypasses execute()
  // wrapper because tracks alone are not a user-facing action and addItems
  // immediately follows). We keep all mutations within the same call stack
  // so undo collapses cleanly into a small number of steps.
  const itemsStore = useItemsStore.getState()
  const nextTracks = [...itemsStore.tracks, ...built.newTracks]
  itemsStore.setTracks(nextTracks)
  useTimelineSettingsStore.getState().markDirty()

  const allItems: TimelineItem[] = [...built.videoItems, ...built.audioItems, ...built.textItems]
  addItems(allItems)

  const itemIds = allItems.map((i) => i.id)
  const comp = createPreComp(params.name, itemIds)

  // Stamp generation metadata onto the resulting SubComposition so the
  // "Regenerate Narration…" right-click flow can locate items in place.
  // We update outside `createPreComp` because that helper doesn't accept
  // metadata; the extra setState is fine since regen is rare.
  if (comp?.id && params.metadataContext) {
    const ctx = params.metadataContext
    const metadata: SpoilerCompositionMetadata = {
      version: 1,
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
      granularity: ctx.granularity,
      addSubtitles: ctx.addSubtitles,
      generateCover: ctx.generateCover,
      includeOriginalAudio: ctx.includeOriginalAudio,
      sourceFilmMediaId: params.sourceMediaId,
    }
    useCompositionsStore.getState().updateComposition(comp.id, { spoilerMetadata: metadata })
  }

  return {
    compositionId: comp?.id ?? null,
    totalDurationFrames: built.totalDurationFrames,
    segmentsPlaced: built.videoItems.length,
  }
}

export { buildSubtitleItemsForSegment as buildSpoilerSubtitleItemsForSegment }

export const __test = { buildItemsForAssembly, buildBaseTrack, buildSubtitleItemsForSegment }
