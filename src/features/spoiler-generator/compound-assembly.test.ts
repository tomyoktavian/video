import { describe, expect, it } from 'vite-plus/test'

import { __test } from './compound-assembly'

const { buildSubtitleItemsForSegment } = __test

const baseSegment = {
  index: 0,
  sourceStartSec: 0,
  sourceEndSec: 10,
  finalDurationSec: 5,
  narration: 'Pemuda itu tiba di kota.',
}

describe('buildSubtitleItemsForSegment — transcript fallback', () => {
  it('returns [] when narration is empty and no transcript is given', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-1',
      segment: { ...baseSegment, narration: '   ' },
      cursorFrame: 0,
      segmentDurationFrames: 150,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      granularity: 'phrase',
      transcript: undefined,
    })
    expect(items).toEqual([])
  })

  it('emits a single subtitle covering the full segment when transcript is missing', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-1',
      segment: baseSegment,
      cursorFrame: 60,
      segmentDurationFrames: 150,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      granularity: 'word',
      transcript: undefined,
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('Pemuda itu tiba di kota.')
    expect(items[0]!.from).toBe(60)
    expect(items[0]!.durationInFrames).toBe(150)
  })
})

describe('buildSubtitleItemsForSegment — word-level transcript', () => {
  const transcript = [
    {
      text: 'Hello world friend.',
      start: 0,
      end: 1.5,
      words: [
        { text: 'Hello', start: 0, end: 0.5 },
        { text: 'world', start: 0.5, end: 1.0 },
        { text: 'friend.', start: 1.0, end: 1.5 },
      ],
    },
  ]

  it('emits one item per word when granularity = "word"', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-sub',
      segment: { ...baseSegment, narration: 'Hello world friend.' },
      cursorFrame: 100,
      segmentDurationFrames: 60,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      granularity: 'word',
      transcript,
    })
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.text)).toEqual(['Hello', 'world', 'friend.'])
    expect(items[0]!.from).toBe(100)
    expect(items[1]!.from).toBe(115)
    expect(items[2]!.from).toBe(130)
  })

  it('uses shadow-only styling — transparent background + textShadow', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-sub',
      segment: { ...baseSegment, narration: 'Hello world friend.' },
      cursorFrame: 0,
      segmentDurationFrames: 60,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      granularity: 'word',
      transcript,
    })
    const first = items[0]!
    expect(first.backgroundColor).toBe('transparent')
    expect(first.textShadow).toEqual({
      offsetX: 0,
      offsetY: 2,
      blur: 8,
      color: 'rgba(0, 0, 0, 0.85)',
    })
    expect(first.color).toBe('#ffffff')
  })

  it('clamps subtitle items inside the segment frame window', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-sub',
      segment: { ...baseSegment, narration: 'Hello world friend.' },
      cursorFrame: 100,
      // Segment shorter than transcript span (1.5 s = 45 frames @ 30 fps).
      segmentDurationFrames: 30,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      granularity: 'word',
      transcript,
    })
    for (const item of items) {
      expect(item.from).toBeGreaterThanOrEqual(100)
      expect(item.from + item.durationInFrames).toBeLessThanOrEqual(130)
    }
  })
})
