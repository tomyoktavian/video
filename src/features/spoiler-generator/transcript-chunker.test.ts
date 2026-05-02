import { describe, expect, it } from 'vite-plus/test'

import { chunkAndSummarizeIfNeeded, __test } from './transcript-chunker'

const { findSceneBoundaries, chunkTranscript } = __test

describe('findSceneBoundaries', () => {
  it('returns [0] for empty / single-segment transcripts', () => {
    expect(findSceneBoundaries([])).toEqual([0])
    expect(findSceneBoundaries([{ text: 'a', start: 0, end: 1 }])).toEqual([0])
  })

  it('detects gap > 8s as a scene boundary', () => {
    const segs = [
      { text: 'a', start: 0, end: 5 },
      { text: 'b', start: 6, end: 8 }, // 1s gap — same scene
      { text: 'c', start: 20, end: 24 }, // 12s gap — new scene
      { text: 'd', start: 25, end: 27 },
    ]
    expect(findSceneBoundaries(segs)).toEqual([0, 2])
  })

  it('respects custom gap threshold', () => {
    const segs = [
      { text: 'a', start: 0, end: 5 },
      { text: 'b', start: 7, end: 9 }, // 2s gap
    ]
    expect(findSceneBoundaries(segs, 1)).toEqual([0, 1])
    expect(findSceneBoundaries(segs, 5)).toEqual([0])
  })
})

describe('chunkTranscript', () => {
  it('returns one chunk for short transcripts', () => {
    const segs = [
      { text: 'short', start: 0, end: 1 },
      { text: 'still short', start: 2, end: 3 },
    ]
    const chunks = chunkTranscript(segs)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.segments).toHaveLength(2)
  })

  it('splits when the cumulative char length exceeds the cap', () => {
    const big = 'x'.repeat(30_000)
    const segs = [
      { text: big, start: 0, end: 5 },
      { text: 'second scene', start: 30, end: 35 }, // 25s gap — boundary
      { text: big, start: 40, end: 45 },
    ]
    const chunks = chunkTranscript(segs, { maxCharLength: 50_000 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('preserves full coverage', () => {
    const segs = [
      { text: 'a', start: 0, end: 1 },
      { text: 'b', start: 2, end: 3 },
      { text: 'c', start: 50, end: 51 },
    ]
    const chunks = chunkTranscript(segs)
    const totalSegs = chunks.reduce((sum, c) => sum + c.segments.length, 0)
    expect(totalSegs).toBe(3)
  })
})

describe('chunkAndSummarizeIfNeeded', () => {
  it('passes through short transcripts unchanged', async () => {
    const segs = [{ text: 'short', start: 0, end: 1 }]
    const result = await chunkAndSummarizeIfNeeded({ segments: segs })
    expect(result.didChunk).toBe(false)
    expect(result.flatTranscript).toEqual(segs)
    expect(result.chunkSummaries).toEqual([])
  })

  it('returns flatTranscript = lastChunk and summaries[] for early chunks when long', async () => {
    const big = 'word '.repeat(15_000) // ~75k chars
    const segs = [
      { text: big, start: 0, end: 100 },
      { text: 'climax line', start: 200, end: 250 }, // 100s gap → boundary
      { text: 'finale line', start: 300, end: 350 }, // 50s gap → boundary
    ]
    const seenChunkIndexes: number[] = []
    const result = await chunkAndSummarizeIfNeeded({
      segments: segs,
      thresholdCharLength: 60_000,
      summarize: async (chunk) => {
        seenChunkIndexes.push(chunk.index)
        return `summary-of-chunk-${chunk.index}`
      },
    })
    expect(result.didChunk).toBe(true)
    expect(result.chunkSummaries.length).toBeGreaterThanOrEqual(1)
    expect(result.flatTranscript.length).toBeGreaterThan(0)
  })

  it('honours abort signal mid-summarization', async () => {
    const big = 'x'.repeat(40_000)
    // Force multiple early chunks by constructing four scene-bounded big segments.
    const segs = [
      { text: big, start: 0, end: 100 },
      { text: big, start: 200, end: 300 },
      { text: big, start: 400, end: 500 },
      { text: 'finale', start: 600, end: 650 },
    ]
    const controller = new AbortController()
    let summarizeCalls = 0
    const promise = chunkAndSummarizeIfNeeded({
      segments: segs,
      thresholdCharLength: 60_000,
      summarize: async () => {
        summarizeCalls += 1
        controller.abort()
        return 'aborted-during-call'
      },
      signal: controller.signal,
    })
    await expect(promise).rejects.toThrow(/abort/i)
    expect(summarizeCalls).toBeGreaterThanOrEqual(1)
  })
})
