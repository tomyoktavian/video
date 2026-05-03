/**
 * Episode planner — groups resolved spoiler segments into N episode buckets
 * for Episode Mode. Each bucket targets `[minDurationSec, maxDurationSec]`
 * seconds of body content (segments only — opening/closing TTS are added on
 * top by the assembly stage and counted separately).
 *
 * Two modes:
 *   - **Greedy** (default): fill buckets greedily, snap to segment boundary.
 *     Episode count is derived from total duration ÷ bounds.
 *   - **Targeted** (`targetEpisodeCount`): partition into exactly N buckets,
 *     placing each segment into the bucket with the smallest running total.
 *     Min/max are honored as best-effort guidance — the count is the hard
 *     constraint, so over/undershoot is logged but tolerated.
 */

export interface EpisodeBucket {
  /** 1-based episode number. */
  episodeIndex: number
  /** Indices into the original segment array, in order. */
  segmentIndices: number[]
  /** Whether this episode begins with a TTS opening line + boundary visual. */
  includesOpening: boolean
  /** Whether this episode ends with a TTS closing line + boundary visual. */
  includesClosing: boolean
  /** Sum of segment finalDurationSec (excludes opening/closing overhead). */
  estimatedBodyDurationSec: number
}

export interface PlanEpisodesInput {
  /** Per-segment final duration in seconds (post sync-to-narration). */
  segmentDurationsSec: readonly number[]
  /** Min seconds per episode body. */
  minDurationSec: number
  /** Max seconds per episode body. */
  maxDurationSec: number
  /**
   * Target number of episode buckets. When set, overrides the greedy bin
   * packer and partitions all segments into exactly this many buckets
   * (clamped to `[1, segments.length]`).
   */
  targetEpisodeCount?: number
}

export function planEpisodes(input: PlanEpisodesInput): EpisodeBucket[] {
  const { segmentDurationsSec, minDurationSec, maxDurationSec, targetEpisodeCount } = input

  if (segmentDurationsSec.length === 0) return []
  if (minDurationSec <= 0 || maxDurationSec <= 0 || minDurationSec >= maxDurationSec) {
    throw new Error(`Invalid episode duration bounds: min=${minDurationSec}, max=${maxDurationSec}`)
  }

  if (typeof targetEpisodeCount === 'number' && targetEpisodeCount > 0) {
    return planByTargetCount(segmentDurationsSec, targetEpisodeCount)
  }

  const groups: number[][] = []
  let current: number[] = []
  let accumulated = 0

  for (let i = 0; i < segmentDurationsSec.length; i++) {
    const dur = segmentDurationsSec[i]!
    const tentative = accumulated + dur

    if (current.length === 0) {
      current.push(i)
      accumulated = dur
      continue
    }

    if (tentative <= maxDurationSec) {
      current.push(i)
      accumulated = tentative
      continue
    }

    if (accumulated >= minDurationSec) {
      groups.push(current)
      current = [i]
      accumulated = dur
    } else {
      current.push(i)
      accumulated = tentative
    }
  }

  if (current.length > 0) groups.push(current)

  if (groups.length >= 2) {
    const lastIdx = groups.length - 1
    const last = groups[lastIdx]!
    const lastSum = sumDurations(last, segmentDurationsSec)
    if (lastSum < minDurationSec) {
      const prev = groups[lastIdx - 1]!
      prev.push(...last)
      groups.pop()
    }
  }

  return finalizeBuckets(groups, segmentDurationsSec)
}

/**
 * Partition segments into exactly N buckets. Strategy: walk the segments in
 * order accumulating duration; close the current bucket when accumulated
 * duration exceeds `totalDuration / remainingBuckets`. This produces
 * roughly even buckets while preserving segment order — important because
 * scenes are sequential and must keep narrative flow.
 */
function planByTargetCount(
  segmentDurationsSec: readonly number[],
  rawTargetCount: number,
): EpisodeBucket[] {
  const target = Math.max(1, Math.min(segmentDurationsSec.length, Math.floor(rawTargetCount)))
  if (target === 1) {
    const all = segmentDurationsSec.map((_, i) => i)
    return finalizeBuckets([all], segmentDurationsSec)
  }
  if (target === segmentDurationsSec.length) {
    return finalizeBuckets(
      segmentDurationsSec.map((_, i) => [i]),
      segmentDurationsSec,
    )
  }

  const total = segmentDurationsSec.reduce((acc, d) => acc + d, 0)
  const groups: number[][] = []
  let current: number[] = []
  let accumulated = 0
  let remainingTotal = total

  for (let i = 0; i < segmentDurationsSec.length; i++) {
    const dur = segmentDurationsSec[i]!
    const remainingBuckets = target - groups.length
    const remainingSegments = segmentDurationsSec.length - i

    // Reserve at least one segment per remaining bucket beyond the current
    // one — without this, a too-greedy fill at the head leaves later
    // buckets with no segments and we fall short of `target`.
    const reservedSegments = remainingBuckets - 1

    if (remainingSegments <= reservedSegments && current.length > 0) {
      groups.push(current)
      current = [i]
      accumulated = dur
      remainingTotal -= dur
      continue
    }

    const idealBucketSize = remainingTotal / remainingBuckets
    // Closing the current bucket adds one to `groups`. We must keep at
    // least one more bucket open for the remaining segments, so refuse to
    // close once we've already filled `target - 1` slots.
    const canClose = groups.length < target - 1

    if (canClose && current.length > 0 && accumulated + dur > idealBucketSize * 1.5) {
      groups.push(current)
      current = [i]
      accumulated = dur
    } else {
      current.push(i)
      accumulated += dur
    }
    remainingTotal -= dur
  }

  if (current.length > 0) groups.push(current)

  // Top-up: if rounding shorted us a bucket, peel the last segment off the
  // largest bucket into a new one. Repeat until we hit `target`.
  while (groups.length < target) {
    let largestIdx = 0
    for (let i = 1; i < groups.length; i++) {
      if ((groups[i]?.length ?? 0) > (groups[largestIdx]?.length ?? 0)) largestIdx = i
    }
    const largest = groups[largestIdx]!
    if (largest.length < 2) break
    const tail = largest.pop()!
    groups.splice(largestIdx + 1, 0, [tail])
  }

  return finalizeBuckets(groups, segmentDurationsSec)
}

function finalizeBuckets(
  groups: readonly number[][],
  segmentDurationsSec: readonly number[],
): EpisodeBucket[] {
  const total = groups.length
  return groups.map((segmentIndices, i) => ({
    episodeIndex: i + 1,
    segmentIndices: [...segmentIndices],
    includesOpening: total > 1 && i > 0,
    includesClosing: total > 1 && i < total - 1,
    estimatedBodyDurationSec: sumDurations(segmentIndices, segmentDurationsSec),
  }))
}

function sumDurations(indices: readonly number[], durations: readonly number[]): number {
  let acc = 0
  for (const i of indices) acc += durations[i] ?? 0
  return acc
}
