import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('./openai-compatible-vision-config', () => ({
  getOpenAiCompatibleVisionConfig: () => ({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
  }),
}))

import { __test } from './openai-compatible-vision-provider'

const { parseVisionResponse } = __test

describe('openai-compatible-vision-provider parseVisionResponse', () => {
  it('parses plain JSON', () => {
    expect(parseVisionResponse('{"text":"a cat"}')).toEqual({ text: 'a cat' })
  })

  it('strips ```json fences', () => {
    const wrapped = '```json\n{"text":"a dog","sceneData":{"shotType":"close"}}\n```'
    expect(parseVisionResponse(wrapped)).toEqual({
      text: 'a dog',
      sceneData: { shotType: 'close' },
    })
  })

  it('extracts a balanced JSON block from prose', () => {
    const messy = 'Sure! Here is the JSON: {"text":"a bird","sceneData":{"action":"flying"}}. Done.'
    expect(parseVisionResponse(messy)).toEqual({
      text: 'a bird',
      sceneData: { action: 'flying' },
    })
  })

  it('returns empty object for malformed input', () => {
    expect(parseVisionResponse('not json at all')).toEqual({})
  })

  it('returns empty object for empty input', () => {
    expect(parseVisionResponse('')).toEqual({})
  })

  it('returns empty object when balanced block is invalid JSON', () => {
    expect(parseVisionResponse('intro {bad json here} trailer')).toEqual({})
  })
})
