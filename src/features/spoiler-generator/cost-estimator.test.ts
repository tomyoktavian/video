import { describe, expect, it } from 'vite-plus/test'

import {
  estimateAllPresetCosts,
  estimateCostForPreset,
  estimateTokensForTranscript,
  MODEL_PRESETS,
} from './cost-estimator'

const transcript = [
  { text: 'Hello world this is a test transcript', start: 0, end: 4 },
  { text: 'Another line with more words to count carefully', start: 5, end: 10 },
]

describe('estimateTokensForTranscript', () => {
  it('produces non-zero input + output token counts', () => {
    const result = estimateTokensForTranscript(transcript, 900)
    expect(result.inputTokens).toBeGreaterThan(0)
    expect(result.outputTokens).toBeGreaterThan(0)
    expect(result.totalTokens).toBe(result.inputTokens + result.outputTokens)
  })

  it('scales output tokens with target duration', () => {
    const short = estimateTokensForTranscript(transcript, 300)
    const long = estimateTokensForTranscript(transcript, 1800)
    expect(long.outputTokens).toBeGreaterThan(short.outputTokens)
  })

  it('skips empty segments', () => {
    const empty = estimateTokensForTranscript([{ text: '   ', start: 0, end: 1 }], 300)
    const expected = estimateTokensForTranscript([], 300)
    expect(empty.inputTokens).toBe(expected.inputTokens)
  })
})

describe('estimateCostForPreset', () => {
  it('computes a positive USD cost', () => {
    const sonnet = MODEL_PRESETS.find((p) => p.id === 'claude-sonnet-4-6')!
    const estimate = { inputTokens: 20_000, outputTokens: 4_000, totalTokens: 24_000 }
    const cost = estimateCostForPreset(sonnet, estimate)
    // Input: 20000 * 3 / 1M = 0.06 ; Output: 4000 * 15 / 1M = 0.06 → total 0.12
    expect(cost.totalUsd).toBeCloseTo(0.12, 4)
    expect(cost.exceedsContext).toBe(false)
  })

  it('flags context overflow', () => {
    const gpt4o = MODEL_PRESETS.find((p) => p.id === 'gpt-4o')!
    const tooMuch = { inputTokens: 200_000, outputTokens: 5_000, totalTokens: 205_000 }
    expect(estimateCostForPreset(gpt4o, tooMuch).exceedsContext).toBe(true)
  })
})

describe('estimateAllPresetCosts', () => {
  it('returns a cost entry for every preset', () => {
    const { perPreset } = estimateAllPresetCosts(transcript, 900)
    expect(perPreset).toHaveLength(MODEL_PRESETS.length)
    for (const cost of perPreset) {
      expect(cost.totalUsd).toBeGreaterThan(0)
    }
  })
})
