import { describe, expect, it } from 'vite-plus/test'

import { validateAndClampSegments, __test } from './timestamp-validator'
import type { SpoilerScript } from './types'

const { snapRange, resolveOverlaps, findNearestBoundary } = __test

const transcript = [
  { text: 'opening', start: 0, end: 4 },
  { text: 'second', start: 5, end: 9 },
  { text: 'third', start: 10, end: 14 },
  { text: 'fourth', start: 30, end: 34 },
  { text: 'fifth', start: 60, end: 64 },
]

const baseScript = (segments: SpoilerScript['segments']): SpoilerScript => ({
  title: 'T',
  synopsis: 'S',
  segments,
})

describe('findNearestBoundary', () => {
  it('returns nearest boundary within tolerance', () => {
    expect(findNearestBoundary(5.5, [0, 5, 10], 1)).toBe(5)
    expect(findNearestBoundary(7, [0, 5, 10], 3)).toBe(5)
  })

  it('returns null when no boundary within tolerance', () => {
    expect(findNearestBoundary(50, [0, 5, 10], 3)).toBeNull()
    expect(findNearestBoundary(0, [], 5)).toBeNull()
  })
})

describe('snapRange', () => {
  const opts = {
    minClipDurationSec: 0.5,
    padToMinTolerance: 1.0,
    snapToleranceSec: 5,
    dropToleranceSec: 15,
  }

  it('snaps to nearest segment boundary within tolerance', () => {
    const result = snapRange({ startSec: 4.8, endSec: 9.2 }, transcript, opts)
    expect(result).toEqual({ startSec: 5, endSec: 9 })
  })

  it('drops a range with no transcript anchor within drop tolerance', () => {
    const result = snapRange({ startSec: 200, endSec: 220 }, transcript, opts)
    expect(result).toBeNull()
  })

  it('clamps to transcript span', () => {
    const result = snapRange({ startSec: -5, endSec: 64.1 }, transcript, opts)
    expect(result?.startSec).toBeGreaterThanOrEqual(0)
    expect(result?.endSec).toBeLessThanOrEqual(64)
  })

  it('drops a range with inverted duration', () => {
    const result = snapRange({ startSec: 30, endSec: 25 }, transcript, opts)
    expect(result).toBeNull()
  })

  it('drops a range below minimum duration when snap and pad cannot rescue it', () => {
    // Tiny transcript [10, 10.05]; range much smaller than min duration; no headroom to pad.
    const tiny = [{ text: 'x', start: 10, end: 10.05 }]
    const result = snapRange({ startSec: 10, endSec: 10.02 }, tiny, {
      ...opts,
      padToMinTolerance: 0,
      minClipDurationSec: 5,
      snapToleranceSec: 0,
    })
    expect(result).toBeNull()
  })
})

describe('resolveOverlaps', () => {
  const seg = (start: number, end: number, idx = 0) => ({
    index: idx,
    narration: `seg-${idx}`,
    selectedClipRange: { startSec: start, endSec: end },
    estimatedNarrationSec: end - start,
  })

  it('passes non-overlapping segments through', () => {
    const result = resolveOverlaps([seg(0, 5, 0), seg(10, 15, 1), seg(20, 25, 2)])
    expect(result).toHaveLength(3)
  })

  it('keeps the longer of two overlapping segments', () => {
    const result = resolveOverlaps([
      seg(0, 5, 0), // length 5
      seg(3, 12, 1), // length 9 — keep this
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.selectedClipRange).toEqual({ startSec: 3, endSec: 12 })
  })

  it('sorts by start time before resolving', () => {
    const result = resolveOverlaps([seg(20, 25, 2), seg(0, 5, 0), seg(10, 15, 1)])
    expect(result[0]?.selectedClipRange.startSec).toBe(0)
    expect(result[1]?.selectedClipRange.startSec).toBe(10)
    expect(result[2]?.selectedClipRange.startSec).toBe(20)
  })
})

describe('validateAndClampSegments', () => {
  it('snaps, drops hallucinations, dedups, and reassigns indexes', () => {
    const result = validateAndClampSegments(
      baseScript([
        // valid, will snap
        {
          index: 0,
          narration: 'a',
          selectedClipRange: { startSec: 4.7, endSec: 9.1 },
          estimatedNarrationSec: 4,
        },
        // hallucinated — far from transcript
        {
          index: 1,
          narration: 'b',
          selectedClipRange: { startSec: 500, endSec: 520 },
          estimatedNarrationSec: 4,
        },
        // valid — later in film
        {
          index: 2,
          narration: 'c',
          selectedClipRange: { startSec: 30, endSec: 34 },
          estimatedNarrationSec: 4,
        },
      ]),
      transcript,
    )
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.index).toBe(0)
    expect(result.segments[1]?.index).toBe(1)
    expect(result.segments[0]?.narration).toBe('a')
    expect(result.segments[1]?.narration).toBe('c')
  })

  it('preserves title and synopsis', () => {
    const result = validateAndClampSegments(
      {
        title: 'My Title',
        synopsis: 'My Synopsis',
        segments: [
          {
            index: 0,
            narration: 'a',
            selectedClipRange: { startSec: 5, endSec: 9 },
            estimatedNarrationSec: 4,
          },
        ],
      },
      transcript,
    )
    expect(result.title).toBe('My Title')
    expect(result.synopsis).toBe('My Synopsis')
  })

  it('preserves narration order chronologically', () => {
    const result = validateAndClampSegments(
      baseScript([
        {
          index: 0,
          narration: 'late',
          selectedClipRange: { startSec: 60, endSec: 64 },
          estimatedNarrationSec: 4,
        },
        {
          index: 1,
          narration: 'early',
          selectedClipRange: { startSec: 0, endSec: 4 },
          estimatedNarrationSec: 4,
        },
      ]),
      transcript,
    )
    expect(result.segments[0]?.narration).toBe('early')
    expect(result.segments[1]?.narration).toBe('late')
  })
})
