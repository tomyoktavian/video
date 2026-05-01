/**
 * Builds subtitle text items for a highlight plan at ABSOLUTE main-timeline
 * positions. Items are added to the main timeline first, then passed to
 * `createPreComp` as companions — which repositions them to comp-internal
 * coordinates (`from = item.from - minFrom`) automatically.
 *
 * One subtitle TextItem per transcript segment, bottom-centre, white bold.
 *
 * The AI-generated `plan.title` is intentionally NOT rendered as a TextItem
 * here — it's used directly as the resulting compound clip's name (via
 * `createPreComp(plan.title, …)` in the highlight-actions module).
 */

import type { TextItem, TimelineItem, TimelineTrack } from '@/types/timeline'

import type { HighlightFinderClipContext, ResolvedHighlightPlan } from './types'

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
  /** The resolved plan for this highlight (used for splitFrames, fps, source times). */
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

  if (!addSubtitles) return { textItems, tracksToAdd }

  // Working copies so track/item additions are visible to subsequent lookups.
  let workingTracks: TimelineTrack[] = [...existingTracks]
  const workingItems: TimelineItem[] = [...existingItems]

  const planFrom = plan.splitFrames[0]
  const compDurationInFrames = plan.splitFrames[1] - plan.splitFrames[0]
  const fps = plan.fps

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
