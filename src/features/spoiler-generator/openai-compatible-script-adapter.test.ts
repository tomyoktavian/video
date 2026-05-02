import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { __test } from './openai-compatible-script-adapter'

const { parseScriptResponse, buildUserMessage, resolveLanguageLabel } = __test

const validRaw = JSON.stringify({
  title: 'Pengkhianatan Tak Terduga',
  synopsis: 'Sebuah film tentang persahabatan dan pengkhianatan.',
  segments: [
    {
      index: 0,
      narration: 'Pemuda itu tiba di kota baru dengan harapan baru.',
      selectedClipRange: { startSec: 5, endSec: 25 },
      rationale: 'Membuka cerita',
      estimatedNarrationSec: 4.5,
    },
    {
      index: 1,
      narration: 'Ia bertemu sahabat lama yang ternyata menyimpan rahasia gelap.',
      selectedClipRange: { startSec: 60, endSec: 80 },
      estimatedNarrationSec: 6,
    },
  ],
})

describe('parseScriptResponse', () => {
  it('parses a clean JSON script with title, synopsis, and segments', () => {
    const result = parseScriptResponse(validRaw)
    expect(result).not.toBeNull()
    expect(result?.title).toBe('Pengkhianatan Tak Terduga')
    expect(result?.synopsis).toContain('persahabatan')
    expect(result?.segments).toHaveLength(2)
    expect(result?.segments[0]?.narration).toContain('kota baru')
    expect(result?.segments[0]?.selectedClipRange).toEqual({ startSec: 5, endSec: 25 })
    expect(result?.segments[0]?.rationale).toBe('Membuka cerita')
    expect(result?.segments[1]?.rationale).toBeUndefined()
  })

  it('strips markdown fences', () => {
    const fenced = '```json\n' + validRaw + '\n```'
    const result = parseScriptResponse(fenced)
    expect(result?.segments).toHaveLength(2)
  })

  it('extracts a balanced JSON block from prose preamble', () => {
    const prose = 'Here is your spoiler script: ' + validRaw + ' Hope this helps!'
    const result = parseScriptResponse(prose)
    expect(result?.segments).toHaveLength(2)
  })

  it('drops segments with missing narration, missing range, or inverted range', () => {
    const raw = JSON.stringify({
      title: 'Test',
      synopsis: '',
      segments: [
        { narration: 'Valid', selectedClipRange: { startSec: 0, endSec: 5 } },
        { narration: '', selectedClipRange: { startSec: 10, endSec: 15 } },
        { narration: 'No range' },
        {
          narration: 'Inverted',
          selectedClipRange: { startSec: 30, endSec: 25 },
        },
      ],
    })
    const result = parseScriptResponse(raw)
    expect(result?.segments).toHaveLength(1)
    expect(result?.segments[0]?.narration).toBe('Valid')
  })

  it('falls back to estimating narration duration from word count when missing', () => {
    const raw = JSON.stringify({
      title: 'T',
      synopsis: '',
      segments: [
        {
          narration: 'satu dua tiga empat lima', // 5 words
          selectedClipRange: { startSec: 0, endSec: 5 },
        },
      ],
    })
    const result = parseScriptResponse(raw)
    expect(result?.segments[0]?.estimatedNarrationSec).toBeGreaterThan(0)
    expect(result?.segments[0]?.estimatedNarrationSec).toBeLessThan(5)
  })

  it('returns null on malformed input or empty segments', () => {
    expect(parseScriptResponse('not json')).toBeNull()
    expect(parseScriptResponse('')).toBeNull()
    expect(parseScriptResponse(JSON.stringify({ title: 'x', segments: [] }))).toBeNull()
    expect(parseScriptResponse(JSON.stringify({ title: 'x' }))).toBeNull()
  })

  it('defaults title to "Spoiler" when missing or blank', () => {
    const raw = JSON.stringify({
      segments: [{ narration: 'x', selectedClipRange: { startSec: 0, endSec: 1 } }],
    })
    expect(parseScriptResponse(raw)?.title).toBe('Spoiler')
  })

  it('assigns fallback indexes when missing', () => {
    const raw = JSON.stringify({
      title: 't',
      segments: [
        { narration: 'a', selectedClipRange: { startSec: 0, endSec: 1 } },
        { narration: 'b', selectedClipRange: { startSec: 2, endSec: 3 } },
      ],
    })
    const result = parseScriptResponse(raw)
    expect(result?.segments[0]?.index).toBe(0)
    expect(result?.segments[1]?.index).toBe(1)
  })
})

describe('buildUserMessage', () => {
  const baseTranscript = [
    { text: 'Selamat datang di kota ini', start: 5, end: 8 },
    { text: 'Aku sudah lama menunggumu', start: 60, end: 64 },
  ]

  it('includes target duration, language label, clip duration, and transcript', () => {
    const message = buildUserMessage({
      transcript: baseTranscript,
      perChunkSummaries: [],
      targetDurationSec: 900,
      narrationLanguage: 'id',
      clipDurationSec: 20,
    })
    expect(message).toContain('15.0 minutes')
    expect(message).toContain('Bahasa Indonesia')
    expect(message).toContain('20.0 seconds')
    expect(message).toContain('Selamat datang')
    expect(message).toContain('Aku sudah lama')
  })

  it('uses Bahasa Indonesia label by default for empty/auto language', () => {
    expect(resolveLanguageLabel('')).toBe('Bahasa Indonesia')
    expect(resolveLanguageLabel('auto')).toBe('Bahasa Indonesia')
    expect(resolveLanguageLabel(undefined)).toBe('Bahasa Indonesia')
  })

  it('resolves common ISO codes to readable labels', () => {
    expect(resolveLanguageLabel('en')).toBe('English')
    expect(resolveLanguageLabel('ja')).toBe('Japanese')
    expect(resolveLanguageLabel('zh')).toBe('Chinese (Mandarin)')
  })

  it('falls back to raw code for unknown languages', () => {
    expect(resolveLanguageLabel('jv-XX')).toBe('jv-XX')
  })

  it('appends per-chunk summaries when provided', () => {
    const message = buildUserMessage({
      transcript: baseTranscript,
      perChunkSummaries: ['First half summary', 'Second half summary'],
      targetDurationSec: 600,
      narrationLanguage: 'en',
      clipDurationSec: 15,
    })
    expect(message).toContain('Earlier-portion summaries')
    expect(message).toContain('Chunk 1')
    expect(message).toContain('First half summary')
    expect(message).toContain('Chunk 2')
    expect(message).toContain('Second half summary')
  })

  it('skips empty transcript text entries', () => {
    const message = buildUserMessage({
      transcript: [
        { text: '   ', start: 0, end: 1 },
        { text: 'Real line', start: 2, end: 3 },
      ],
      perChunkSummaries: [],
      targetDurationSec: 60,
      narrationLanguage: 'id',
      clipDurationSec: 10,
    })
    expect(message).toContain('Real line')
    // Empty entries should not appear as bare timestamp markers
    expect(message).not.toMatch(/0\.00s.{0,5}1\.00s:\s*$/m)
  })
})
