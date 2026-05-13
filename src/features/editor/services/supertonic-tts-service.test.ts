import { describe, expect, it } from 'vite-plus/test'
import {
  SUPERTONIC_TTS_DEFAULT_LANGUAGE,
  SUPERTONIC_TTS_DEFAULT_QUALITY,
  SUPERTONIC_TTS_DEFAULT_VOICE,
  SUPERTONIC_TTS_LANGUAGES,
  SUPERTONIC_TTS_QUALITY_MAX,
  SUPERTONIC_TTS_QUALITY_MIN,
  SUPERTONIC_TTS_VOICE_OPTIONS,
  getSupertonicTtsLanguageOption,
  getSupertonicTtsVoiceOption,
  supertonicTtsService,
} from './supertonic-tts-service'

describe('supertonicTtsService', () => {
  it('exposes the documented voice catalog with M3 default first', () => {
    expect(SUPERTONIC_TTS_VOICE_OPTIONS.length).toBe(10)
    expect(SUPERTONIC_TTS_VOICE_OPTIONS[0].value).toBe('M3')
    expect(SUPERTONIC_TTS_VOICE_OPTIONS.map((option) => option.value)).toEqual(
      expect.arrayContaining(['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5']),
    )
  })

  it('exposes 31 supported languages plus auto-detect', () => {
    expect(SUPERTONIC_TTS_LANGUAGES.length).toBe(32)
    expect(SUPERTONIC_TTS_LANGUAGES[0].value).toBe('auto')
    expect(SUPERTONIC_TTS_LANGUAGES.map((option) => option.value)).toEqual(
      expect.arrayContaining(['en', 'id', 'ja', 'ko', 'ar', 'de', 'fr', 'es', 'vi']),
    )
  })

  it('has sensible default voice, language, and quality', () => {
    expect(SUPERTONIC_TTS_DEFAULT_VOICE).toBe('M3')
    expect(SUPERTONIC_TTS_DEFAULT_LANGUAGE).toBe('auto')
    expect(SUPERTONIC_TTS_DEFAULT_QUALITY).toBeGreaterThanOrEqual(SUPERTONIC_TTS_QUALITY_MIN)
    expect(SUPERTONIC_TTS_DEFAULT_QUALITY).toBeLessThanOrEqual(SUPERTONIC_TTS_QUALITY_MAX)
  })

  it('returns labels for known voices and falls back gracefully for unknown', () => {
    expect(getSupertonicTtsVoiceOption('M3').label).toMatch(/Robert/)
    expect(getSupertonicTtsVoiceOption('Z9' as never)).toEqual({ value: 'Z9', label: 'Z9' })
  })

  it('returns labels for known languages and falls back gracefully for unknown', () => {
    expect(getSupertonicTtsLanguageOption('id').label).toBe('Indonesian')
    expect(getSupertonicTtsLanguageOption('xx' as never)).toEqual({ value: 'xx', label: 'xx' })
  })

  it('reports support when Worker + caches are available in the environment', () => {
    const originalWorker = (globalThis as { Worker?: unknown }).Worker
    const originalCaches = (globalThis as { caches?: unknown }).caches

    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: class {},
    })
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { open: () => Promise.resolve({}) },
    })

    expect(supertonicTtsService.isSupported()).toBe(true)

    if (originalWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker
    } else {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker })
    }
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches
    } else {
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
    }
  })
})
