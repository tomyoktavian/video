import { describe, expect, it } from 'vite-plus/test'

import { buildHighlightTextItems } from './build-highlight-text-items'
import type { HighlightFinderClipContext, ResolvedHighlightPlan } from './types'

const CANVAS = { width: 1920, height: 1080 }

function makePlan(overrides: Partial<ResolvedHighlightPlan> = {}): ResolvedHighlightPlan {
  return {
    itemId: 'item-1',
    splitFrames: [120, 240],
    title: 'AI Generated Hook',
    mediaId: 'media-1',
    sourceStartSec: 0,
    sourceEndSec: 4,
    fps: 30,
    ...overrides,
  }
}

function makeContext(
  overrides: Partial<HighlightFinderClipContext> = {},
): HighlightFinderClipContext {
  return {
    itemId: 'item-1',
    mediaId: 'media-1',
    mediaFileName: 'clip.mp4',
    sourceStartSec: 0,
    sourceEndSec: 4,
    timelineStartFrame: 0,
    timelineEndFrame: 240,
    fps: 30,
    sourceFps: 30,
    captions: [],
    transcriptSegments: [],
    ...overrides,
  }
}

describe('buildHighlightTextItems', () => {
  it('never emits a title TextItem — the AI title is reserved for the compound clip name', () => {
    const result = buildHighlightTextItems({
      plan: makePlan({ title: 'AI Generated Hook' }),
      context: makeContext({
        transcriptSegments: [{ text: 'Hello there', start: 0.5, end: 1.5 }],
      }),
      addSubtitles: true,
      canvasWidth: CANVAS.width,
      canvasHeight: CANVAS.height,
      existingTracks: [],
      existingItems: [],
    })

    // Confirm none of the produced text items echo the AI hook as their text.
    for (const item of result.textItems) {
      expect(item.text).not.toBe('AI Generated Hook')
    }
  })

  it('returns no items when addSubtitles is off', () => {
    const result = buildHighlightTextItems({
      plan: makePlan(),
      context: makeContext({
        transcriptSegments: [{ text: 'Hello there', start: 0.5, end: 1.5 }],
      }),
      addSubtitles: false,
      canvasWidth: CANVAS.width,
      canvasHeight: CANVAS.height,
      existingTracks: [],
      existingItems: [],
    })

    expect(result.textItems).toEqual([])
    expect(result.tracksToAdd).toEqual([])
  })

  it('emits one subtitle TextItem per overlapping transcript segment', () => {
    const result = buildHighlightTextItems({
      plan: makePlan({ sourceStartSec: 0, sourceEndSec: 4 }),
      context: makeContext({
        transcriptSegments: [
          { text: 'Halo semua', start: 0.2, end: 1.0 },
          { text: 'selamat datang', start: 1.0, end: 2.0 },
          { text: 'di luar jangkauan', start: 5.0, end: 6.0 }, // outside the highlight range
        ],
      }),
      addSubtitles: true,
      canvasWidth: CANVAS.width,
      canvasHeight: CANVAS.height,
      existingTracks: [],
      existingItems: [],
    })

    expect(result.textItems).toHaveLength(2)
    expect(result.textItems[0]?.text).toBe('Halo semua')
    expect(result.textItems[1]?.text).toBe('selamat datang')
  })

  it('positions subtitles at the bottom of the canvas', () => {
    const result = buildHighlightTextItems({
      plan: makePlan(),
      context: makeContext({
        transcriptSegments: [{ text: 'caption', start: 0.5, end: 1.5 }],
      }),
      addSubtitles: true,
      canvasWidth: CANVAS.width,
      canvasHeight: CANVAS.height,
      existingTracks: [],
      existingItems: [],
    })

    // transform.y is offset from canvas centre — positive = down. Subtitles
    // should sit in the lower half of the canvas.
    expect(result.textItems[0]?.transform?.y).toBeGreaterThan(0)
  })
})
