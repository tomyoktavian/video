/**
 * Validates and clamps Script Writer output against the actual transcript
 * timeline. The LLM may hallucinate timestamps outside the transcript span,
 * pick ranges shorter than the minimum useful clip duration, or emit
 * overlapping ranges. This module:
 *
 *   1. **Snaps** each `selectedClipRange` to the nearest transcript segment
 *      boundary within ±5s tolerance — Whisper boundaries are usually the
 *      most natural cut points.
 *   2. **Drops** segments whose range has no transcript anchor within ±15s
 *      (almost certainly hallucinated).
 *   3. **Clamps** to the global transcript [start, end] span.
 *   4. **Enforces** a minimum clip duration (default 0.5s).
 *   5. **Resolves overlap** by keeping the longer segment.
 *   6. **Sorts** by start time and reassigns sequential indexes.
 */

import type { MediaTranscriptSegment } from '@/types/storage'

import type { SpoilerScript, SpoilerSegment } from './types'

export interface ValidatorOptions {
  /** Minimum allowed clip duration in seconds. Below this, segment is dropped. */
  minClipDurationSec?: number
  /**
   * Soft target — segments shorter than `minClipDurationSec` but within this
   * tolerance get padded forward to reach the minimum. Default 1s.
   */
  padToMinTolerance?: number
  /** Snap distance (seconds). Default 5. */
  snapToleranceSec?: number
  /** Drop distance — beyond this from any segment, treat as hallucination. Default 15. */
  dropToleranceSec?: number
}

const DEFAULTS: Required<ValidatorOptions> = {
  minClipDurationSec: 0.5,
  padToMinTolerance: 1.0,
  snapToleranceSec: 5,
  dropToleranceSec: 15,
}

interface SnappedRange {
  startSec: number
  endSec: number
}

function findNearestBoundary(
  targetSec: number,
  boundaries: readonly number[],
  toleranceSec: number,
): number | null {
  if (boundaries.length === 0) return null
  let best: number | null = null
  let bestDelta = Infinity
  for (const b of boundaries) {
    const delta = Math.abs(b - targetSec)
    if (delta < bestDelta) {
      bestDelta = delta
      best = b
    }
  }
  if (best === null) return null
  return bestDelta <= toleranceSec ? best : null
}

function nearestSegmentDistance(
  targetSec: number,
  segments: readonly MediaTranscriptSegment[],
): number {
  let best = Infinity
  for (const seg of segments) {
    if (targetSec >= seg.start && targetSec <= seg.end) return 0
    const d = Math.min(Math.abs(seg.start - targetSec), Math.abs(seg.end - targetSec))
    if (d < best) best = d
  }
  return best
}

function snapRange(
  range: { startSec: number; endSec: number },
  segments: readonly MediaTranscriptSegment[],
  options: Required<ValidatorOptions>,
): SnappedRange | null {
  if (segments.length === 0) return null

  const transcriptStart = segments[0]?.start ?? 0
  const transcriptEnd = segments[segments.length - 1]?.end ?? 0
  if (!Number.isFinite(transcriptStart) || !Number.isFinite(transcriptEnd)) return null

  // Hallucination check.
  const startDist = nearestSegmentDistance(range.startSec, segments)
  const endDist = nearestSegmentDistance(range.endSec, segments)
  if (startDist > options.dropToleranceSec && endDist > options.dropToleranceSec) {
    return null
  }

  const startBoundaries = segments.map((s) => s.start)
  const endBoundaries = segments.map((s) => s.end)

  const snappedStart = findNearestBoundary(
    range.startSec,
    startBoundaries,
    options.snapToleranceSec,
  )
  const snappedEnd = findNearestBoundary(range.endSec, endBoundaries, options.snapToleranceSec)

  let startSec = snappedStart ?? Math.max(transcriptStart, range.startSec)
  let endSec = snappedEnd ?? Math.min(transcriptEnd, range.endSec)

  startSec = Math.max(transcriptStart, Math.min(startSec, transcriptEnd))
  endSec = Math.max(transcriptStart, Math.min(endSec, transcriptEnd))

  if (endSec <= startSec) return null

  const duration = endSec - startSec
  if (duration < options.minClipDurationSec) {
    if (duration + options.padToMinTolerance >= options.minClipDurationSec) {
      const need = options.minClipDurationSec - duration
      endSec = Math.min(transcriptEnd, endSec + need)
      if (endSec - startSec < options.minClipDurationSec) {
        startSec = Math.max(
          transcriptStart,
          startSec - (options.minClipDurationSec - (endSec - startSec)),
        )
      }
      if (endSec - startSec < options.minClipDurationSec) return null
    } else {
      return null
    }
  }

  return { startSec, endSec }
}

function resolveOverlaps(segments: SpoilerSegment[]): SpoilerSegment[] {
  if (segments.length <= 1) return segments
  const sorted = [...segments].sort(
    (a, b) => a.selectedClipRange.startSec - b.selectedClipRange.startSec,
  )
  const out: SpoilerSegment[] = []
  for (const seg of sorted) {
    const prev = out[out.length - 1]
    if (!prev) {
      out.push(seg)
      continue
    }
    const prevEnd = prev.selectedClipRange.endSec
    const segStart = seg.selectedClipRange.startSec
    if (segStart >= prevEnd) {
      out.push(seg)
      continue
    }
    // Overlap — keep the longer one.
    const prevLen = prev.selectedClipRange.endSec - prev.selectedClipRange.startSec
    const segLen = seg.selectedClipRange.endSec - seg.selectedClipRange.startSec
    if (segLen > prevLen) {
      out[out.length - 1] = seg
    }
    // else: keep prev, drop seg
  }
  return out
}

/**
 * Validates a {@link SpoilerScript} against the actual transcript and returns
 * a script with cleaned-up segments. May discard segments that fail the
 * hallucination or minimum-duration checks.
 */
export function validateAndClampSegments(
  script: SpoilerScript,
  transcriptSegments: readonly MediaTranscriptSegment[],
  options: ValidatorOptions = {},
): SpoilerScript {
  const opts: Required<ValidatorOptions> = { ...DEFAULTS, ...options }

  const cleaned: SpoilerSegment[] = []
  for (const seg of script.segments) {
    const snapped = snapRange(seg.selectedClipRange, transcriptSegments, opts)
    if (!snapped) continue
    cleaned.push({
      ...seg,
      selectedClipRange: snapped,
    })
  }

  const dedeuped = resolveOverlaps(cleaned)
  const indexed = dedeuped.map((seg, i) => ({ ...seg, index: i }))

  return {
    title: script.title,
    synopsis: script.synopsis,
    segments: indexed,
  }
}

export const __test = { snapRange, resolveOverlaps, findNearestBoundary }
