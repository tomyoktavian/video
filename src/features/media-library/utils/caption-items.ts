import {
  DEFAULT_TRACK_HEIGHT,
  getEffectiveTrackKindForItem,
  getNextClassicTrackName,
  type TrackKind,
} from '../deps/timeline-contract'
import type { MediaTranscriptSegment } from '@/types/storage'
import type { MediaCaption } from '@/infrastructure/analysis'
import type {
  AudioItem,
  GeneratedCaptionSource,
  TextItem,
  TimelineItem,
  TimelineTrack,
  VideoItem,
} from '@/types/timeline'
import { timelineToSourceFrames } from '../deps/timeline-contract'

/**
 * Fallback segment duration when AI captions can't infer an `end` time from
 * the next caption (i.e. for the last caption, or when the sample interval is
 * unknown). Seconds.
 */
const AI_CAPTION_FALLBACK_DURATION_SEC = 3

/**
 * Subtitle display granularity:
 *   - `'word'` — one text item per spoken word (karaoke-style, requires
 *     word-level timing from the transcript).
 *   - `'phrase'` — 4-5 word chunks ("TikTok/CapCut" style); the historical
 *     default and most readable for short-form content.
 *   - `'sentence'` — one text item per sentence (`.!?…` boundary); best for
 *     long-form / movie-style subtitles.
 *
 * When word-level timing is unavailable (legacy transcripts, providers like
 * `gpt-4o-transcribe` that omit timestamps), all modes fall back to a single
 * chunk per segment so the caller still gets usable output.
 */
export type SubtitleGranularity = 'word' | 'phrase' | 'sentence'

export const DEFAULT_SUBTITLE_GRANULARITY: SubtitleGranularity = 'phrase'

/**
 * Word-grouping thresholds for the `'phrase'` mode. A new chunk opens when
 * any of these limits is hit. Tweaking these here changes the global feel
 * of phrase-mode subtitles.
 */
const TARGET_WORDS_PER_CHUNK = 4
const MAX_WORDS_PER_CHUNK = 5
const MAX_CHUNK_SECONDS = 1.5
const NATURAL_BREAK_GAP_SECONDS = 0.25
const CLAUSE_BREAK_PATTERN = /[.!?,;:]\s*$/
const SENTENCE_END_PATTERN = /[.!?…]\s*$/

interface CaptionChunk {
  text: string
  start: number
  end: number
}

/**
 * Break a transcript segment into per-word caption chunks. Each word becomes
 * its own chunk timed to the word's `start`/`end`. Useful for karaoke /
 * reaction-style captions.
 */
function chunkSegmentPerWord(segment: MediaTranscriptSegment): CaptionChunk[] {
  const words = segment.words
  if (!words || words.length === 0) {
    return [{ text: segment.text, start: segment.start, end: segment.end }]
  }
  return words
    .map((word) => ({
      text: word.text.trim(),
      start: word.start,
      end: Math.max(word.end, word.start),
    }))
    .filter((chunk) => chunk.text.length > 0 && chunk.end >= chunk.start)
}

/**
 * Break a transcript segment into per-sentence caption chunks. A new chunk
 * opens after any word ending with `.`, `!`, `?`, or `…`. Falls back to the
 * raw segment text when the model returned no per-word timing.
 */
function chunkSegmentPerSentence(segment: MediaTranscriptSegment): CaptionChunk[] {
  const words = segment.words
  if (!words || words.length === 0) {
    return [{ text: segment.text, start: segment.start, end: segment.end }]
  }
  const chunks: CaptionChunk[] = []
  let bucket: typeof words = []
  const flush = () => {
    if (bucket.length === 0) return
    const first = bucket[0]!
    const last = bucket.at(-1)!
    chunks.push({
      text: bucket
        .map((w) => w.text.trim())
        .filter(Boolean)
        .join(' '),
      start: first.start,
      end: last.end,
    })
    bucket = []
  }
  for (const word of words) {
    bucket.push(word)
    if (SENTENCE_END_PATTERN.test(word.text)) flush()
  }
  flush()
  return chunks.filter((chunk) => chunk.text.length > 0 && chunk.end >= chunk.start)
}

/**
 * Break a transcript segment into 4-5 word "phrase" chunks (the historical
 * default). Re-exported for consumers that want this behaviour explicitly.
 */
function chunkSegmentPerPhrase(segment: MediaTranscriptSegment): CaptionChunk[] {
  const words = segment.words
  if (!words || words.length === 0) {
    return [{ text: segment.text, start: segment.start, end: segment.end }]
  }

  const chunks: CaptionChunk[] = []
  let bucket: typeof words = []

  const flush = () => {
    if (bucket.length === 0) return
    const first = bucket[0]!
    const last = bucket.at(-1)!
    chunks.push({
      text: bucket
        .map((w) => w.text.trim())
        .filter(Boolean)
        .join(' '),
      start: first.start,
      end: last.end,
    })
    bucket = []
  }

  for (const word of words) {
    const previous = bucket.at(-1)
    if (previous) {
      const first = bucket[0]!
      const gap = word.start - previous.end
      const bucketDuration = previous.end - first.start
      const reachedMax = bucket.length >= MAX_WORDS_PER_CHUNK
      const wouldExceedDuration = word.end - first.start > MAX_CHUNK_SECONDS
      const sentenceBreak = SENTENCE_END_PATTERN.test(previous.text)
      const reachedTargetWithBreakSignal =
        bucket.length >= TARGET_WORDS_PER_CHUNK &&
        (gap >= NATURAL_BREAK_GAP_SECONDS ||
          CLAUSE_BREAK_PATTERN.test(previous.text) ||
          bucketDuration >= MAX_CHUNK_SECONDS)

      if (reachedMax || wouldExceedDuration || sentenceBreak || reachedTargetWithBreakSignal) {
        flush()
      }
    }
    bucket.push(word)
  }
  flush()

  return chunks.filter((chunk) => chunk.text.length > 0 && chunk.end >= chunk.start)
}

/**
 * Break a Whisper transcript segment into smaller caption chunks based on
 * the requested {@link SubtitleGranularity}. Defaults to `'phrase'` for
 * backward compatibility with the previous implementation.
 */
export function subdivideSegmentIntoWordGroups(
  segment: MediaTranscriptSegment,
  granularity: SubtitleGranularity = DEFAULT_SUBTITLE_GRANULARITY,
): CaptionChunk[] {
  switch (granularity) {
    case 'word':
      return chunkSegmentPerWord(segment)
    case 'sentence':
      return chunkSegmentPerSentence(segment)
    case 'phrase':
    default:
      return chunkSegmentPerPhrase(segment)
  }
}

interface BuildCaptionTextItemsOptions {
  mediaId: string
  trackId: string
  segments: readonly MediaTranscriptSegment[]
  clip: AudioItem | VideoItem
  timelineFps: number
  canvasWidth: number
  canvasHeight: number
  styleTemplate?: CaptionTextItemTemplate
  /**
   * Discriminator for the `captionSource.type` stamped on the generated
   * text items. Defaults to `'transcript'` (whisper flow); AI captioning
   * flows pass `'ai-captions'` so later replace/remove operations can tell
   * the two kinds apart on the same clip.
   */
  sourceType?: GeneratedCaptionSource['type']
  /**
   * How aggressively to subdivide each transcript segment into individual
   * caption text items. Defaults to `'phrase'` (4-5 word groups, the
   * historical behaviour).
   */
  granularity?: SubtitleGranularity
}

export type CaptionTextItemTemplate = Pick<
  TextItem,
  | 'fontSize'
  | 'fontFamily'
  | 'fontWeight'
  | 'fontStyle'
  | 'underline'
  | 'color'
  | 'backgroundColor'
  | 'textAlign'
  | 'verticalAlign'
  | 'lineHeight'
  | 'letterSpacing'
  | 'textShadow'
  | 'stroke'
  | 'transform'
>

export interface CaptionableClipRange {
  clip: AudioItem | VideoItem
  startFrame: number
  endFrame: number
}

export function normalizeCaptionSegments(
  segments: readonly MediaTranscriptSegment[],
): MediaTranscriptSegment[] {
  return segments
    .map((segment) => {
      const start = Math.max(0, segment.start)
      const end = Math.max(start, segment.end)
      const words = segment.words
        ?.map((word) => ({
          text: word.text.trim(),
          start: Math.max(0, word.start),
          end: Math.max(Math.max(0, word.start), word.end),
        }))
        .filter((word) => word.text.length > 0 && word.end >= word.start)
      return {
        text: segment.text.trim(),
        start,
        end,
        ...(words && words.length > 0 ? { words } : {}),
      }
    })
    .filter((segment) => segment.text.length > 0 && segment.end > segment.start)
}

export function getCaptionFrameRange(
  segments: readonly MediaTranscriptSegment[],
  fps: number,
): { startFrame: number; endFrame: number } | null {
  const normalized = normalizeCaptionSegments(segments)
  const first = normalized[0]
  const last = normalized.at(-1)

  if (!first || !last) {
    return null
  }

  return {
    startFrame: Math.round(first.start * fps),
    endFrame: Math.max(Math.round(last.end * fps), Math.round(first.start * fps) + 1),
  }
}

function toSourceStartFrame(seconds: number, sourceFps: number): number {
  return Math.max(0, Math.round(seconds * sourceFps))
}

function toSourceEndFrame(seconds: number, sourceFps: number): number {
  return Math.max(0, Math.round(seconds * sourceFps))
}

function sourceFramesToTimelineFramesFloor(
  sourceFrames: number,
  speed: number,
  sourceFps: number,
  timelineFps: number,
): number {
  if (sourceFrames <= 0) {
    return 0
  }

  const sourceSeconds = sourceFrames / sourceFps
  return Math.max(0, Math.floor((sourceSeconds * timelineFps) / speed))
}

function sourceFramesToTimelineFramesCeil(
  sourceFrames: number,
  speed: number,
  sourceFps: number,
  timelineFps: number,
): number {
  if (sourceFrames <= 0) {
    return 0
  }

  const sourceSeconds = sourceFrames / sourceFps
  return Math.max(0, Math.ceil((sourceSeconds * timelineFps) / speed))
}

function getClipSourceBounds(
  clip: AudioItem | VideoItem,
  timelineFps: number,
): {
  sourceStart: number
  sourceEnd: number
  sourceFps: number
  speed: number
} {
  const speed = clip.speed ?? 1
  const sourceStart = clip.sourceStart ?? 0
  const sourceFps = clip.sourceFps ?? timelineFps
  const derivedSourceEnd =
    sourceStart + timelineToSourceFrames(clip.durationInFrames, speed, timelineFps, sourceFps)

  return {
    sourceStart,
    sourceEnd: clip.sourceEnd ?? derivedSourceEnd,
    sourceFps,
    speed,
  }
}

export function getCaptionRangeForClip(
  clip: AudioItem | VideoItem,
  segments: readonly MediaTranscriptSegment[],
  timelineFps: number,
): { startFrame: number; endFrame: number } | null {
  const normalizedSegments = normalizeCaptionSegments(segments)
  if (normalizedSegments.length === 0) {
    return null
  }

  const { sourceStart, sourceEnd, sourceFps, speed } = getClipSourceBounds(clip, timelineFps)
  let firstFrame: number | null = null
  let lastFrame: number | null = null

  for (const segment of normalizedSegments) {
    const segmentSourceStart = toSourceStartFrame(segment.start, sourceFps)
    const segmentSourceEnd = toSourceEndFrame(segment.end, sourceFps)
    const overlapStart = Math.max(sourceStart, segmentSourceStart)
    const overlapEnd = Math.min(sourceEnd, segmentSourceEnd)

    if (overlapEnd <= overlapStart) {
      continue
    }

    const startOffset = sourceFramesToTimelineFramesFloor(
      overlapStart - sourceStart,
      speed,
      sourceFps,
      timelineFps,
    )
    const endOffset = sourceFramesToTimelineFramesCeil(
      overlapEnd - sourceStart,
      speed,
      sourceFps,
      timelineFps,
    )

    const startFrame = clip.from + Math.min(startOffset, clip.durationInFrames - 1)
    const endFrame =
      clip.from + Math.min(clip.durationInFrames, Math.max(startOffset + 1, endOffset))

    firstFrame = firstFrame === null ? startFrame : Math.min(firstFrame, startFrame)
    lastFrame = lastFrame === null ? endFrame : Math.max(lastFrame, endFrame)
  }

  if (firstFrame === null || lastFrame === null || lastFrame <= firstFrame) {
    return null
  }

  return { startFrame: firstFrame, endFrame: lastFrame }
}

export function findCompatibleCaptionTrack(
  tracks: readonly TimelineTrack[],
  items: readonly TimelineItem[],
  startFrame: number,
  endFrame: number,
): TimelineTrack | null {
  return findCompatibleGeneratedTrackForRanges(tracks, items, [{ startFrame, endFrame }], 'video')
}

export function findCompatibleCaptionTrackForRanges(
  tracks: readonly TimelineTrack[],
  items: readonly TimelineItem[],
  ranges: ReadonlyArray<{ startFrame: number; endFrame: number }>,
): TimelineTrack | null {
  return findCompatibleGeneratedTrackForRanges(tracks, items, ranges, 'video')
}

export function findCompatibleGeneratedTrackForRanges(
  tracks: readonly TimelineTrack[],
  items: readonly TimelineItem[],
  ranges: ReadonlyArray<{ startFrame: number; endFrame: number }>,
  requiredKind: TrackKind,
): TimelineTrack | null {
  const sortedTracks = [...tracks].sort((a, b) => a.order - b.order)

  for (const track of sortedTracks) {
    if (!isGeneratedContentTrackCandidate(track, items, requiredKind)) {
      continue
    }

    const hasOverlap = ranges.some((range) =>
      items.some((item) => {
        if (item.trackId !== track.id) {
          return false
        }

        const itemEnd = item.from + item.durationInFrames
        return item.from < range.endFrame && itemEnd > range.startFrame
      }),
    )

    if (!hasOverlap) {
      return track
    }
  }

  return null
}

export function isGeneratedContentTrackCandidate(
  track: TimelineTrack,
  items: readonly TimelineItem[],
  requiredKind: TrackKind,
): boolean {
  if (track.visible === false || track.locked || track.isGroup) {
    return false
  }

  const effectiveKind = getEffectiveTrackKindForItem(track, items)
  if (requiredKind === 'audio') {
    return effectiveKind === 'audio'
  }

  return effectiveKind === 'video' || effectiveKind === null
}

export function isCaptionTrackCandidate(
  track: TimelineTrack,
  items: readonly TimelineItem[],
): boolean {
  return isGeneratedContentTrackCandidate(track, items, 'video')
}

export function buildCaptionTrack(tracks: readonly TimelineTrack[]): TimelineTrack {
  const maxOrder = tracks.reduce((highest, track) => Math.max(highest, track.order), -1)
  return {
    id: `track-captions-${Date.now()}`,
    name: getNextClassicTrackName([...tracks], 'video'),
    kind: 'video',
    height: DEFAULT_TRACK_HEIGHT,
    locked: false,
    syncLock: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order: maxOrder + 1,
    items: [],
  }
}

/**
 * Build a captions track positioned *above* a reference track (the clip's
 * own track in the AI-captions flow). The new track's `order` is set halfway
 * between `referenceOrder` and the next track up, so both stay unique and no
 * existing tracks need to shift.
 *
 * If nothing sits above the reference, we land a full integer lower than it.
 * Matches the fractional-order pattern used by `insertTrack` in
 * `use-timeline-tracks.ts`.
 */
export function buildCaptionTrackAbove(
  tracks: readonly TimelineTrack[],
  referenceOrder: number,
): TimelineTrack {
  const ordersStrictlyAbove = tracks.map((t) => t.order).filter((order) => order < referenceOrder)
  const previousOrder =
    ordersStrictlyAbove.length > 0 ? Math.max(...ordersStrictlyAbove) : referenceOrder - 2
  const newOrder = (previousOrder + referenceOrder) / 2

  return {
    id: `track-captions-${Date.now()}`,
    name: getNextClassicTrackName([...tracks], 'video'),
    kind: 'video',
    height: DEFAULT_TRACK_HEIGHT,
    locked: false,
    syncLock: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order: newOrder,
    items: [],
  }
}

function buildCaptionSource(
  mediaId: string,
  clipId: string,
  type: GeneratedCaptionSource['type'] = 'transcript',
): GeneratedCaptionSource {
  return {
    type,
    mediaId,
    clipId,
  }
}

/**
 * Convert AI captions (point-in-time frame descriptions) into segments with
 * start/end pairs consumable by {@link buildCaptionTextItems}.
 *
 * AI captions have no intrinsic duration — the end time is derived from the
 * next caption's `timeSec`, with a fallback to the provider's sample interval
 * (or {@link AI_CAPTION_FALLBACK_DURATION_SEC}) for the final caption.
 */
export function aiCaptionsToSegments(
  captions: readonly MediaCaption[],
  sampleIntervalSec?: number,
): MediaTranscriptSegment[] {
  if (captions.length === 0) return []
  const sorted = [...captions].sort((a, b) => a.timeSec - b.timeSec)
  const fallbackEndDelta =
    sampleIntervalSec && sampleIntervalSec > 0
      ? sampleIntervalSec
      : AI_CAPTION_FALLBACK_DURATION_SEC

  return sorted.map((caption, index) => {
    const next = sorted[index + 1]
    const start = Math.max(0, caption.timeSec)
    const end = next !== undefined ? Math.max(start + 0.01, next.timeSec) : start + fallbackEndDelta
    return {
      text: caption.text,
      start,
      end,
    }
  })
}

export function isGeneratedCaptionTextItem(
  item: TimelineItem,
): item is TextItem & { captionSource: GeneratedCaptionSource } {
  return (
    item.type === 'text' &&
    (item.captionSource?.type === 'transcript' || item.captionSource?.type === 'ai-captions') &&
    item.captionSource.clipId.length > 0 &&
    item.captionSource.mediaId.length > 0
  )
}

export function findGeneratedCaptionItemsForClip(
  items: readonly TimelineItem[],
  clipId: string,
  sourceType?: GeneratedCaptionSource['type'],
): Array<TextItem & { captionSource: GeneratedCaptionSource }> {
  return items.filter(
    (item): item is TextItem & { captionSource: GeneratedCaptionSource } =>
      isGeneratedCaptionTextItem(item) &&
      item.captionSource.clipId === clipId &&
      (sourceType === undefined || item.captionSource.type === sourceType),
  )
}

function isLegacyGeneratedCaptionItemForClip(
  item: TimelineItem,
  clip: AudioItem | VideoItem,
): item is TextItem {
  if (item.type !== 'text' || item.captionSource || item.mediaId !== clip.mediaId) {
    return false
  }

  const clipEnd = clip.from + clip.durationInFrames
  const itemEnd = item.from + item.durationInFrames
  return (
    item.from >= clip.from &&
    itemEnd <= clipEnd &&
    item.text.trim().length > 0 &&
    item.label === item.text.slice(0, 48)
  )
}

export function findReplaceableCaptionItemsForClip(
  items: readonly TimelineItem[],
  clip: AudioItem | VideoItem,
  sourceType?: GeneratedCaptionSource['type'],
): TextItem[] {
  const generatedCaptionItems = findGeneratedCaptionItemsForClip(items, clip.id, sourceType)
  if (generatedCaptionItems.length > 0) {
    return generatedCaptionItems
  }

  // Legacy fallback only applies to transcript-generated captions (the only
  // kind that predates the `captionSource` discriminator).
  if (sourceType !== undefined && sourceType !== 'transcript') {
    return []
  }
  return items.filter((item): item is TextItem => isLegacyGeneratedCaptionItemForClip(item, clip))
}

/**
 * Shadow-only subtitle styling shared by Highlight Finder and Spoiler
 * Generator: white text, transparent background, drop shadow for legibility
 * over arbitrary footage. Centred horizontally, sits at ~35 % of canvas
 * height below centre.
 */
export interface SubtitleTextItemInput {
  trackId: string
  from: number
  durationInFrames: number
  text: string
  canvasWidth: number
  canvasHeight: number
  /** Optional caption-source discriminator (whisper transcript vs AI). */
  captionSource?: GeneratedCaptionSource
  /** Optional source media id stamped onto the text item. */
  mediaId?: string
}

export function buildSubtitleTextItem(input: SubtitleTextItemInput): TextItem {
  const { trackId, from, durationInFrames, text, canvasWidth, canvasHeight } = input
  const fontSize = Math.max(32, Math.round(canvasHeight * 0.042))
  return {
    id: crypto.randomUUID(),
    type: 'text',
    textRole: 'caption',
    trackId,
    from,
    durationInFrames,
    text,
    label: text.slice(0, 48),
    fontSize,
    fontFamily: 'Inter',
    fontWeight: 'semibold',
    fontStyle: 'normal',
    underline: false,
    color: '#ffffff',
    backgroundColor: 'transparent',
    textAlign: 'center',
    verticalAlign: 'middle',
    lineHeight: 1.15,
    letterSpacing: 0,
    textShadow: {
      offsetX: 0,
      offsetY: 2,
      blur: 8,
      color: 'rgba(0, 0, 0, 0.85)',
    },
    transform: {
      x: 0,
      y: Math.round(canvasHeight * 0.35),
      width: canvasWidth * 0.82,
      height: canvasHeight * 0.14,
      rotation: 0,
      opacity: 1,
    },
    ...(input.mediaId ? { mediaId: input.mediaId } : {}),
    ...(input.captionSource ? { captionSource: input.captionSource } : {}),
  }
}

export function getCaptionTextItemTemplate(item: TextItem): CaptionTextItemTemplate {
  return {
    fontSize: item.fontSize,
    fontFamily: item.fontFamily,
    fontWeight: item.fontWeight,
    fontStyle: item.fontStyle,
    underline: item.underline,
    color: item.color,
    backgroundColor: item.backgroundColor,
    textAlign: item.textAlign,
    verticalAlign: item.verticalAlign,
    lineHeight: item.lineHeight,
    letterSpacing: item.letterSpacing,
    textShadow: item.textShadow ? { ...item.textShadow } : undefined,
    stroke: item.stroke ? { ...item.stroke } : undefined,
    transform: item.transform ? { ...item.transform } : undefined,
  }
}

export function buildCaptionTextItems({
  mediaId,
  trackId,
  segments,
  clip,
  timelineFps,
  canvasWidth,
  canvasHeight,
  styleTemplate,
  sourceType = 'transcript',
  granularity = DEFAULT_SUBTITLE_GRANULARITY,
}: BuildCaptionTextItemsOptions): TextItem[] {
  const normalizedSegments = normalizeCaptionSegments(segments)
  const { sourceStart, sourceEnd, sourceFps, speed } = getClipSourceBounds(clip, timelineFps)

  return normalizedSegments.flatMap((segment) =>
    subdivideSegmentIntoWordGroups(segment, granularity).flatMap((chunk) => {
      const chunkSourceStart = toSourceStartFrame(chunk.start, sourceFps)
      const chunkSourceEnd = toSourceEndFrame(chunk.end, sourceFps)
      const overlapStart = Math.max(sourceStart, chunkSourceStart)
      const overlapEnd = Math.min(sourceEnd, chunkSourceEnd)

      if (overlapEnd <= overlapStart) {
        return []
      }

      const startOffset = sourceFramesToTimelineFramesFloor(
        overlapStart - sourceStart,
        speed,
        sourceFps,
        timelineFps,
      )
      const endOffset = sourceFramesToTimelineFramesCeil(
        overlapEnd - sourceStart,
        speed,
        sourceFps,
        timelineFps,
      )
      const from = clip.from + Math.min(startOffset, clip.durationInFrames - 1)
      const endFrame =
        clip.from + Math.min(clip.durationInFrames, Math.max(startOffset + 1, endOffset))
      const durationInFrames = Math.max(1, endFrame - from)
      const defaultCaptionItem: TextItem = {
        id: crypto.randomUUID(),
        type: 'text',
        textRole: 'caption',
        trackId,
        from,
        durationInFrames,
        mediaId,
        captionSource: buildCaptionSource(mediaId, clip.id, sourceType),
        label: chunk.text.slice(0, 48),
        text: chunk.text,
        fontSize: Math.max(36, Math.round(canvasHeight * 0.045)),
        fontFamily: 'Inter',
        fontWeight: 'semibold',
        fontStyle: 'normal',
        underline: false,
        color: '#ffffff',
        // backgroundColor: 'rgba(0, 0, 0, 0.55)',
        backgroundColor: 'transparent',
        textAlign: 'center',
        verticalAlign: 'middle',
        lineHeight: 1.15,
        letterSpacing: 0,
        textShadow: {
          offsetX: 0,
          offsetY: 3,
          blur: 10,
          color: 'rgba(0, 0, 0, 0.75)',
        },
        transform: {
          x: 0,
          y: Math.round(canvasHeight * 0.32),
          width: canvasWidth * 0.82,
          height: canvasHeight * 0.16,
          rotation: 0,
          opacity: 1,
        },
      }

      return [
        {
          ...defaultCaptionItem,
          ...styleTemplate,
        },
      ]
    }),
  )
}
