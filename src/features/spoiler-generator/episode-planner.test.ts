import { describe, expect, it } from 'vite-plus/test'

import { planEpisodes } from './episode-planner'

describe('planEpisodes', () => {
  it('returns [] for empty input', () => {
    expect(
      planEpisodes({ segmentDurationsSec: [], minDurationSec: 60, maxDurationSec: 120 }),
    ).toEqual([])
  })

  it('produces a single bucket with no opening/closing when total fits in [min, max]', () => {
    const buckets = planEpisodes({
      segmentDurationsSec: [20, 30, 25],
      minDurationSec: 60,
      maxDurationSec: 120,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.episodeIndex).toBe(1)
    expect(buckets[0]!.segmentIndices).toEqual([0, 1, 2])
    expect(buckets[0]!.includesOpening).toBe(false)
    expect(buckets[0]!.includesClosing).toBe(false)
    expect(buckets[0]!.estimatedBodyDurationSec).toBe(75)
  })

  it('splits into N evenly-sized episodes for uniform segments at exactly N*target', () => {
    const segs = Array.from({ length: 12 }, () => 30)
    const buckets = planEpisodes({
      segmentDurationsSec: segs,
      minDurationSec: 60,
      maxDurationSec: 120,
    })
    expect(buckets).toHaveLength(3)
    expect(buckets[0]!.segmentIndices).toEqual([0, 1, 2, 3])
    expect(buckets[1]!.segmentIndices).toEqual([4, 5, 6, 7])
    expect(buckets[2]!.segmentIndices).toEqual([8, 9, 10, 11])
    expect(buckets[0]!.includesOpening).toBe(false)
    expect(buckets[0]!.includesClosing).toBe(true)
    expect(buckets[1]!.includesOpening).toBe(true)
    expect(buckets[1]!.includesClosing).toBe(true)
    expect(buckets[2]!.includesOpening).toBe(true)
    expect(buckets[2]!.includesClosing).toBe(false)
  })

  it('snaps to segment boundary when next segment would exceed max', () => {
    const buckets = planEpisodes({
      segmentDurationsSec: [50, 50, 30, 50, 50],
      minDurationSec: 60,
      maxDurationSec: 120,
    })
    expect(buckets).toHaveLength(2)
    expect(buckets[0]!.segmentIndices).toEqual([0, 1])
    expect(buckets[0]!.estimatedBodyDurationSec).toBe(100)
    expect(buckets[1]!.segmentIndices).toEqual([2, 3, 4])
    expect(buckets[1]!.estimatedBodyDurationSec).toBe(130)
  })

  it('accepts a single segment longer than max as a degenerate one-segment bucket', () => {
    const buckets = planEpisodes({
      segmentDurationsSec: [200],
      minDurationSec: 60,
      maxDurationSec: 120,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.segmentIndices).toEqual([0])
    expect(buckets[0]!.estimatedBodyDurationSec).toBe(200)
    expect(buckets[0]!.includesOpening).toBe(false)
    expect(buckets[0]!.includesClosing).toBe(false)
  })

  it('keeps a < min sub-bucket when followed by an oversized segment', () => {
    const buckets = planEpisodes({
      segmentDurationsSec: [40, 200, 80],
      minDurationSec: 60,
      maxDurationSec: 120,
    })
    expect(buckets).toHaveLength(2)
    expect(buckets[0]!.segmentIndices).toEqual([0, 1])
    expect(buckets[1]!.segmentIndices).toEqual([2])
  })

  it('merges a tiny tail into the previous bucket', () => {
    const buckets = planEpisodes({
      segmentDurationsSec: [60, 60, 25],
      minDurationSec: 60,
      maxDurationSec: 120,
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.segmentIndices).toEqual([0, 1, 2])
    expect(buckets[0]!.estimatedBodyDurationSec).toBe(145)
  })

  it('throws when bounds are invalid', () => {
    expect(() =>
      planEpisodes({ segmentDurationsSec: [10], minDurationSec: 0, maxDurationSec: 60 }),
    ).toThrow(/Invalid episode duration bounds/)
    expect(() =>
      planEpisodes({ segmentDurationsSec: [10], minDurationSec: 120, maxDurationSec: 60 }),
    ).toThrow(/Invalid episode duration bounds/)
  })

  it('tags includesOpening=false on the first bucket and includesClosing=false on the last', () => {
    const buckets = planEpisodes({
      segmentDurationsSec: [60, 60, 60, 60],
      minDurationSec: 60,
      maxDurationSec: 120,
    })
    expect(buckets).toHaveLength(2)
    expect(buckets[0]!.includesOpening).toBe(false)
    expect(buckets[0]!.includesClosing).toBe(true)
    expect(buckets[1]!.includesOpening).toBe(true)
    expect(buckets[1]!.includesClosing).toBe(false)
  })

  describe('targetEpisodeCount', () => {
    it('produces exactly the requested number of buckets when segments allow', () => {
      const segs = Array.from({ length: 12 }, () => 30)
      const buckets = planEpisodes({
        segmentDurationsSec: segs,
        minDurationSec: 60,
        maxDurationSec: 120,
        targetEpisodeCount: 4,
      })
      expect(buckets).toHaveLength(4)
      // All segments must be allocated (total duration preserved).
      const allIndices = buckets.flatMap((b) => b.segmentIndices)
      expect(allIndices).toHaveLength(12)
      const totalAllocated = buckets.reduce((acc, b) => acc + b.estimatedBodyDurationSec, 0)
      expect(totalAllocated).toBe(360)
    })

    it('clamps target above segment count to one-segment-per-bucket', () => {
      const buckets = planEpisodes({
        segmentDurationsSec: [30, 30, 30],
        minDurationSec: 60,
        maxDurationSec: 120,
        targetEpisodeCount: 99,
      })
      expect(buckets).toHaveLength(3)
      expect(buckets[0]!.segmentIndices).toEqual([0])
      expect(buckets[1]!.segmentIndices).toEqual([1])
      expect(buckets[2]!.segmentIndices).toEqual([2])
    })

    it('clamps target=1 to a single bucket containing all segments', () => {
      const buckets = planEpisodes({
        segmentDurationsSec: [30, 30, 30, 30],
        minDurationSec: 60,
        maxDurationSec: 120,
        targetEpisodeCount: 1,
      })
      expect(buckets).toHaveLength(1)
      expect(buckets[0]!.segmentIndices).toEqual([0, 1, 2, 3])
      expect(buckets[0]!.includesOpening).toBe(false)
      expect(buckets[0]!.includesClosing).toBe(false)
    })

    it('preserves segment ordering — buckets are contiguous slices', () => {
      const segs = [40, 30, 50, 20, 60, 30, 40]
      const buckets = planEpisodes({
        segmentDurationsSec: segs,
        minDurationSec: 60,
        maxDurationSec: 120,
        targetEpisodeCount: 3,
      })
      expect(buckets).toHaveLength(3)
      const flat = buckets.flatMap((b) => b.segmentIndices)
      expect(flat).toEqual([0, 1, 2, 3, 4, 5, 6])
    })

    it('total runtime ≥ spoiler duration when count = ceil(total/max)', () => {
      const spoilerDurationSec = 1200
      const maxDurationSec = 120
      const expectedCount = Math.ceil(spoilerDurationSec / maxDurationSec)
      // 30 segments of 40s each ≈ 1200s total
      const segs = Array.from({ length: 30 }, () => 40)
      const buckets = planEpisodes({
        segmentDurationsSec: segs,
        minDurationSec: 60,
        maxDurationSec,
        targetEpisodeCount: expectedCount,
      })
      expect(buckets).toHaveLength(expectedCount)
      const total = buckets.reduce((acc, b) => acc + b.estimatedBodyDurationSec, 0)
      expect(total).toBeGreaterThanOrEqual(spoilerDurationSec)
    })
  })
})
