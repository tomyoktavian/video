/**
 * Builds subtitle + title-card text items for a highlight plan at ABSOLUTE
 * main-timeline positions. Items are added to the main timeline first, then
 * passed to `createPreComp` as companions — which repositions them to
 * comp-internal coordinates (`from = item.from - minFrom`) automatically.
 *
 * Subtitle items  — one per transcript segment, bottom-centre, white bold.
 * Title-card item — AI-vibe-matched text preset, top-centre, first ~3 s.
 */

import { buildTextStylePresetTemplate } from '@/shared/typography/text-style-presets'
import type { TextStylePresetId } from '@/shared/typography/text-style-preset-ids'
import type { TextItem, TimelineItem, TimelineTrack } from '@/types/timeline'

import type { HighlightFinderClipContext, ResolvedHighlightPlan } from './types'

// ---------------------------------------------------------------------------
// Vibe → preset mapping
// ---------------------------------------------------------------------------

const VIBE_TO_PRESET: Record<string, TextStylePresetId> = {
  clean: 'clean-title',
  bold: 'poster',
  energetic: 'neon',
  cinematic: 'cinematic',
  modern: 'outline-pill',
}

function resolvePreset(vibe: string | undefined): TextStylePresetId {
  if (!vibe) return 'clean-title'
  return VIBE_TO_PRESET[vibe.toLowerCase()] ?? 'clean-title'
}

// ---------------------------------------------------------------------------
// Track helpers (inline — no cross-feature import needed)
// ---------------------------------------------------------------------------

function hasOverlapInRange(
  items: readonly TimelineItem[],
  trackId: string,
  startFrame: number,
  endFrame: number,
): boolean {
  return items.some(
    (item) =>
      item.trackId === trackId &&
      item.from < endFrame &&
      item.from + item.durationInFrames > startFrame,
  )
}

function findCompatibleTrack(
  tracks: readonly TimelineTrack[],
  items: readonly TimelineItem[],
  ranges: ReadonlyArray<{ from: number; end: number }>,
): TimelineTrack | null {
  const sorted = [...tracks].sort((a, b) => a.order - b.order)
  for (const track of sorted) {
    if (track.locked || track.isGroup || track.visible === false) continue
    if (track.kind === 'audio') continue
    const hasConflict = ranges.some((r) => hasOverlapInRange(items, track.id, r.from, r.end))
    if (!hasConflict) return track
  }
  return null
}

function buildNewTrack(tracks: readonly TimelineTrack[], name: string): TimelineTrack {
  const minOrder = tracks.reduce((min, t) => Math.min(min, t.order), 0)
  return {
    id: `track-hl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    kind: 'video',
    height: 40,
    locked: false,
    syncLock: false,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order: minOrder - 1,
    items: [],
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildHighlightTextItemsOptions {
  /** The resolved plan for this highlight (used for splitFrames, fps, titleStyle, source times). */
  plan: ResolvedHighlightPlan
  /** Clip context (transcript segments) for this highlight. */
  context: HighlightFinderClipContext
  addSubtitles: boolean
  canvasWidth: number
  canvasHeight: number
  /** Current main-timeline tracks (updated across multiple plan iterations). */
  existingTracks: readonly TimelineTrack[]
  /** Current main-timeline items (updated across multiple plan iterations). */
  existingItems: readonly TimelineItem[]
}

export interface BuildHighlightTextItemsResult {
  textItems: TextItem[]
  tracksToAdd: TimelineTrack[]
}

export function buildHighlightTextItems({
  plan,
  context,
  addSubtitles,
  canvasWidth,
  canvasHeight,
  existingTracks,
  existingItems,
}: BuildHighlightTextItemsOptions): BuildHighlightTextItemsResult {
  const textItems: TextItem[] = []
  const tracksToAdd: TimelineTrack[] = []

  // Working copies so track/item additions are visible to subsequent lookups.
  let workingTracks: TimelineTrack[] = [...existingTracks]
  const workingItems: TimelineItem[] = [...existingItems]

  const planFrom = plan.splitFrames[0]
  const compDurationInFrames = plan.splitFrames[1] - plan.splitFrames[0]
  const fps = plan.fps
  const canvas = { width: canvasWidth, height: canvasHeight, fps }

  // ------------------------------------------------------------------
  // Title card (top of screen, AI-vibe preset, first ~3s)
  // Positioned at planFrom on the main timeline; createPreComp will
  // reposition to from=0 inside the comp automatically.
  // ------------------------------------------------------------------
  const presetId = resolvePreset(plan.titleStyle)
  const presetTemplate = buildTextStylePresetTemplate(presetId, canvas)
  const titleDuration = Math.min(Math.round(3 * fps), compDurationInFrames)

  const titleRanges = [{ from: planFrom, end: planFrom + titleDuration }]
  let titleTrack = findCompatibleTrack(workingTracks, workingItems, titleRanges)
  if (!titleTrack) {
    titleTrack = buildNewTrack(workingTracks, 'Highlight Titles')
    tracksToAdd.push(titleTrack)
    workingTracks = [...workingTracks, titleTrack].sort((a, b) => a.order - b.order)
  }

  const titleItem = {
    ...presetTemplate,
    id: crypto.randomUUID(),
    type: 'text' as const,
    trackId: titleTrack.id,
    from: planFrom,
    durationInFrames: titleDuration,
    text: plan.title,
    label: plan.title.slice(0, 48),
    color: presetTemplate.color ?? '#ffffff',
    transform: {
      ...(presetTemplate.transform ?? {}),
      x: 0,
      // transform.y is offset from canvas center (resolveTransform): negative = up.
      y: -Math.round(canvasHeight * 0.35),
      width: canvasWidth * 0.85,
      height: canvasHeight * 0.18,
      rotation: 0,
      opacity: 1,
    },
  } satisfies TextItem
  textItems.push(titleItem)
  workingItems.push(titleItem)

  // ------------------------------------------------------------------
  // Subtitle items (bottom of screen, transcript segments)
  // ------------------------------------------------------------------
  if (!addSubtitles) return { textItems, tracksToAdd }

  const segments = context.transcriptSegments.filter(
    (s) => s.end > plan.sourceStartSec && s.start < plan.sourceEndSec,
  )
  if (segments.length === 0) return { textItems, tracksToAdd }

  const subtitleRanges = segments.map((s) => {
    const relStart = Math.max(s.start - plan.sourceStartSec, 0)
    const relEnd = Math.min(s.end - plan.sourceStartSec, compDurationInFrames / fps)
    return {
      from: planFrom + Math.round(relStart * fps),
      end: planFrom + Math.max(1, Math.round(relEnd * fps)),
    }
  })

  const allSubtitleRange = [{ from: planFrom, end: planFrom + compDurationInFrames }]
  let subtitleTrack = findCompatibleTrack(workingTracks, workingItems, allSubtitleRange)
  if (!subtitleTrack) {
    subtitleTrack = buildNewTrack(workingTracks, 'Highlight Subtitles')
    tracksToAdd.push(subtitleTrack)
    workingTracks = [...workingTracks, subtitleTrack].sort((a, b) => a.order - b.order)
  }

  const subtitleFontSize = Math.max(32, Math.round(canvasHeight * 0.042))

  for (const range of subtitleRanges) {
    const seg = segments[subtitleRanges.indexOf(range)]
    if (!seg) continue
    const durationInFrames = Math.max(1, range.end - range.from)
    const subtitleItem: TextItem = {
      id: crypto.randomUUID(),
      type: 'text',
      trackId: subtitleTrack.id,
      from: range.from,
      durationInFrames,
      text: seg.text.trim(),
      label: seg.text.trim().slice(0, 48),
      fontSize: subtitleFontSize,
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
        // transform.y is offset from canvas center (resolveTransform): positive = down.
        y: Math.round(canvasHeight * 0.35),
        width: canvasWidth * 0.82,
        height: canvasHeight * 0.14,
        rotation: 0,
        opacity: 1,
      },
    }
    textItems.push(subtitleItem)
    workingItems.push(subtitleItem)
  }

  return { textItems, tracksToAdd }
}
