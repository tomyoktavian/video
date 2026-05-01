import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { __test } from './openai-compatible-cover-adapter'

const { parseSuggestions, buildUserMessage } = __test

describe('parseSuggestions', () => {
  it('parses a clean JSON object with titles[]', () => {
    const raw = JSON.stringify({
      titles: [
        { primary: 'TEKNIK', accent: 'JAGO NGOMONG', secondary: 'YANG MENGUBAH HIDUP' },
        { primary: 'CARA', accent: 'BICARA EFEKTIF' },
        { primary: 'TIPS' },
      ],
    })
    expect(parseSuggestions(raw)).toEqual([
      { primary: 'TEKNIK', accent: 'JAGO NGOMONG', secondary: 'YANG MENGUBAH HIDUP' },
      { primary: 'CARA', accent: 'BICARA EFEKTIF' },
      { primary: 'TIPS' },
    ])
  })

  it('strips markdown fences', () => {
    const raw = '```json\n{"titles":[{"primary":"HOOK","accent":"NOW"}]}\n```'
    expect(parseSuggestions(raw)).toEqual([{ primary: 'HOOK', accent: 'NOW' }])
  })

  it('drops invalid entries (missing primary)', () => {
    const raw = JSON.stringify({
      titles: [
        { primary: 'GOOD', accent: 'A' },
        { primary: '', accent: 'B' },
        { accent: 'no primary at all' },
      ],
    })
    expect(parseSuggestions(raw)).toEqual([{ primary: 'GOOD', accent: 'A' }])
  })

  it('caps the result at 3 suggestions', () => {
    const raw = JSON.stringify({
      titles: Array.from({ length: 6 }, (_, i) => ({ primary: `T${i}` })),
    })
    expect(parseSuggestions(raw)).toHaveLength(3)
  })

  it('returns [] on malformed input', () => {
    expect(parseSuggestions('not json')).toEqual([])
    expect(parseSuggestions('')).toEqual([])
  })

  it('extracts a balanced JSON block from prose', () => {
    const raw = 'Here are the titles: {"titles":[{"primary":"GO"}]} done.'
    expect(parseSuggestions(raw)).toEqual([{ primary: 'GO' }])
  })

  it('omits empty accent and secondary fields', () => {
    const raw = JSON.stringify({
      titles: [{ primary: 'X', accent: '', secondary: '   ' }],
    })
    expect(parseSuggestions(raw)).toEqual([{ primary: 'X' }])
  })
})

describe('buildUserMessage', () => {
  it('labels the source as transcript when mode is transcript', () => {
    const message = buildUserMessage({
      mode: 'transcript',
      context: 'halo semua selamat datang',
    })
    expect(message).toContain('VIDEO TRANSCRIPT')
    expect(message).toContain('halo semua selamat datang')
    expect(message).toContain('JSON')
  })

  it('labels the source as user context when mode is manual-prompt', () => {
    const message = buildUserMessage({
      mode: 'manual-prompt',
      context: 'wedding Sari & Andi',
    })
    expect(message).toContain('USER CONTEXT')
    expect(message).toContain('wedding Sari & Andi')
  })

  it('truncates excessively long contexts while keeping the tail', () => {
    const giant = 'A'.repeat(80_000) + 'TAIL_MARKER'
    const message = buildUserMessage({ mode: 'transcript', context: giant })
    expect(message.length).toBeLessThanOrEqual(60_000 + 200)
    expect(message).toContain('TAIL_MARKER')
  })
})
