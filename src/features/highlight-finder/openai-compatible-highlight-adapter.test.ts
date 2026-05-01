import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { __test } from './openai-compatible-highlight-adapter'

const { parseHighlightsResponse, buildUserMessage } = __test

describe('parseHighlightsResponse', () => {
  it('parses a clean JSON object with highlights[]', () => {
    const raw = JSON.stringify({
      highlights: [
        { mediaId: 'm1', startTimeSec: 1.5, endTimeSec: 4.2, title: 'Big laugh' },
        { mediaId: 'm2', startTimeSec: 10, endTimeSec: 14 },
      ],
    })
    expect(parseHighlightsResponse(raw)).toEqual([
      { mediaId: 'm1', startTimeSec: 1.5, endTimeSec: 4.2, title: 'Big laugh' },
      { mediaId: 'm2', startTimeSec: 10, endTimeSec: 14 },
    ])
  })

  it('strips markdown fences', () => {
    const raw = '```json\n{"highlights":[{"mediaId":"x","startTimeSec":0,"endTimeSec":2}]}\n```'
    expect(parseHighlightsResponse(raw)).toEqual([{ mediaId: 'x', startTimeSec: 0, endTimeSec: 2 }])
  })

  it('drops invalid entries (missing mediaId, NaN times, end <= start)', () => {
    const raw = JSON.stringify({
      highlights: [
        { mediaId: 'good', startTimeSec: 0, endTimeSec: 5 },
        { mediaId: '', startTimeSec: 0, endTimeSec: 5 },
        { mediaId: 'bad', startTimeSec: 'oops', endTimeSec: 5 },
        { mediaId: 'inverted', startTimeSec: 5, endTimeSec: 5 },
      ],
    })
    expect(parseHighlightsResponse(raw)).toEqual([
      { mediaId: 'good', startTimeSec: 0, endTimeSec: 5 },
    ])
  })

  it('returns [] on malformed input', () => {
    expect(parseHighlightsResponse('not json')).toEqual([])
    expect(parseHighlightsResponse('')).toEqual([])
  })

  it('extracts a balanced JSON block from prose', () => {
    const raw =
      'Here you go: {"highlights":[{"mediaId":"m1","startTimeSec":0,"endTimeSec":3}]} Done!'
    expect(parseHighlightsResponse(raw)).toEqual([
      { mediaId: 'm1', startTimeSec: 0, endTimeSec: 3 },
    ])
  })
})

describe('buildUserMessage', () => {
  const baseClip = {
    itemId: 'item-1',
    mediaId: 'media-1',
    mediaFileName: 'clip.mp4',
    sourceStartSec: 0,
    sourceEndSec: 10,
    timelineStartFrame: 0,
    timelineEndFrame: 300,
    fps: 30,
    sourceFps: 30,
    captions: [{ timeSec: 1, text: 'A man enters' }],
    transcriptSegments: [{ text: 'Hello there', start: 0.5, end: 1.5 }],
  }

  it('includes targetCount, clip duration, and clip block', () => {
    const message = buildUserMessage({
      clips: [baseClip],
      targetCount: 3,
      clipDurationSec: 12.5,
    })
    expect(message).toContain('Pick exactly 3 highlights')
    expect(message).toContain('approximately 12.5 seconds')
    expect(message).toContain('mediaId="media-1"')
    expect(message).toContain('A man enters')
    expect(message).toContain('Hello there')
  })

  it('drops transcripts when over budget', () => {
    const giantText = 'A '.repeat(50_000)
    const message = buildUserMessage({
      clips: [
        {
          ...baseClip,
          transcriptSegments: [{ text: giantText, start: 0, end: 5 }],
        },
      ],
      targetCount: 1,
      clipDurationSec: 5,
    })
    expect(message).toContain('A man enters')
    expect(message).not.toContain(giantText)
  })

  it('appends a language directive for the title field when titleLanguage is an ISO code', () => {
    const message = buildUserMessage({
      clips: [baseClip],
      targetCount: 1,
      clipDurationSec: 5,
      titleLanguage: 'id',
    })
    expect(message).toContain('Indonesian')
    expect(message.toLowerCase()).toContain('title')
    // rationale should stay English regardless of title language
    expect(message).toContain('rationale')
  })

  it('omits the language directive when titleLanguage is auto, empty, or missing', () => {
    const expectNoDirective = (message: string) => {
      expect(message).not.toMatch(/Write the `title` field in/)
    }

    expectNoDirective(
      buildUserMessage({
        clips: [baseClip],
        targetCount: 1,
        clipDurationSec: 5,
      }),
    )
    expectNoDirective(
      buildUserMessage({
        clips: [baseClip],
        targetCount: 1,
        clipDurationSec: 5,
        titleLanguage: 'auto',
      }),
    )
    expectNoDirective(
      buildUserMessage({
        clips: [baseClip],
        targetCount: 1,
        clipDurationSec: 5,
        titleLanguage: '',
      }),
    )
  })

  it('falls back to the raw code when an unrecognised language tag is passed', () => {
    const message = buildUserMessage({
      clips: [baseClip],
      targetCount: 1,
      clipDurationSec: 5,
      titleLanguage: 'jv-XX',
    })
    expect(message).toContain('jv-XX')
  })
})
