import { describe, expect, it } from 'vite-plus/test'

import {
  isAllCustomAiConfigured,
  isAnyCustomAiConfigured,
  isCaptionMakerConfigured,
  isImageGeneratorConfigured,
  isTextToSpeechConfigured,
  isVisionAnalyzerConfigured,
} from './custom-ai-status'

const captionFull = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'whisper-1',
  language: '',
  cachedModels: [],
  lastLoadedAt: null,
}
const captionEmpty = { ...captionFull, baseUrl: '', apiKey: '', model: '' }

const visionFull = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  highlightFinderPrompt: '',
  coverFinderPrompt: '',
  scriptWriterPrompt: '',
  posterPromptSystemPrompt: '',
  cachedModels: [],
  lastLoadedAt: null,
}
const visionEmpty = { ...visionFull, baseUrl: '', apiKey: '', model: '' }

const ttsFull = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'tts-1',
  voice: 'alloy',
  language: '',
  cachedModels: [],
  cachedVoices: [],
  lastLoadedAt: null,
}
const ttsEmpty = { ...ttsFull, baseUrl: '', apiKey: '', model: '' }

const imageGenFull = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-image-1',
  cachedModels: [],
  lastLoadedAt: null,
}
const imageGenEmpty = { ...imageGenFull, baseUrl: '', apiKey: '', model: '' }

describe('isCaptionMakerConfigured', () => {
  it('returns true when all three required fields are set', () => {
    expect(isCaptionMakerConfigured(captionFull)).toBe(true)
  })

  it('returns false when any required field is empty', () => {
    expect(isCaptionMakerConfigured({ ...captionFull, baseUrl: '' })).toBe(false)
    expect(isCaptionMakerConfigured({ ...captionFull, apiKey: '' })).toBe(false)
    expect(isCaptionMakerConfigured({ ...captionFull, model: '' })).toBe(false)
  })

  it('treats whitespace-only fields as empty', () => {
    expect(isCaptionMakerConfigured({ ...captionFull, apiKey: '   ' })).toBe(false)
    expect(isCaptionMakerConfigured({ ...captionFull, model: '\t\n' })).toBe(false)
  })

  it('returns false for fully empty config', () => {
    expect(isCaptionMakerConfigured(captionEmpty)).toBe(false)
  })
})

describe('isVisionAnalyzerConfigured', () => {
  it('returns true when all required fields are set', () => {
    expect(isVisionAnalyzerConfigured(visionFull)).toBe(true)
  })

  it('returns false when any required field is empty', () => {
    expect(isVisionAnalyzerConfigured({ ...visionFull, model: '' })).toBe(false)
  })
})

describe('isTextToSpeechConfigured', () => {
  it('returns true when all required fields are set', () => {
    expect(isTextToSpeechConfigured(ttsFull)).toBe(true)
  })

  it('returns false when any required field is empty', () => {
    expect(isTextToSpeechConfigured({ ...ttsFull, baseUrl: '' })).toBe(false)
  })
})

describe('isImageGeneratorConfigured', () => {
  it('returns true when all required fields are set', () => {
    expect(isImageGeneratorConfigured(imageGenFull)).toBe(true)
  })

  it('returns false when any required field is empty', () => {
    expect(isImageGeneratorConfigured({ ...imageGenFull, baseUrl: '' })).toBe(false)
    expect(isImageGeneratorConfigured({ ...imageGenFull, apiKey: '' })).toBe(false)
    expect(isImageGeneratorConfigured({ ...imageGenFull, model: '' })).toBe(false)
  })
})

describe('isAnyCustomAiConfigured', () => {
  it('returns true when at least one module is configured', () => {
    expect(
      isAnyCustomAiConfigured({
        captionMaker: captionFull,
        textToSpeech: ttsEmpty,
        visionAnalyzer: visionEmpty,
        imageGenerator: imageGenEmpty,
      }),
    ).toBe(true)
    expect(
      isAnyCustomAiConfigured({
        captionMaker: captionEmpty,
        textToSpeech: ttsFull,
        visionAnalyzer: visionEmpty,
        imageGenerator: imageGenEmpty,
      }),
    ).toBe(true)
    expect(
      isAnyCustomAiConfigured({
        captionMaker: captionEmpty,
        textToSpeech: ttsEmpty,
        visionAnalyzer: visionFull,
        imageGenerator: imageGenEmpty,
      }),
    ).toBe(true)
    expect(
      isAnyCustomAiConfigured({
        captionMaker: captionEmpty,
        textToSpeech: ttsEmpty,
        visionAnalyzer: visionEmpty,
        imageGenerator: imageGenFull,
      }),
    ).toBe(true)
  })

  it('returns false when all modules are empty', () => {
    expect(
      isAnyCustomAiConfigured({
        captionMaker: captionEmpty,
        textToSpeech: ttsEmpty,
        visionAnalyzer: visionEmpty,
        imageGenerator: imageGenEmpty,
      }),
    ).toBe(false)
  })
})

describe('isAllCustomAiConfigured', () => {
  it('returns true only when all three modules are configured', () => {
    expect(
      isAllCustomAiConfigured({
        captionMaker: captionFull,
        textToSpeech: ttsFull,
        visionAnalyzer: visionFull,
      }),
    ).toBe(true)
  })

  it('returns false when any module is missing', () => {
    expect(
      isAllCustomAiConfigured({
        captionMaker: captionFull,
        textToSpeech: ttsFull,
        visionAnalyzer: visionEmpty,
      }),
    ).toBe(false)
    expect(
      isAllCustomAiConfigured({
        captionMaker: captionEmpty,
        textToSpeech: ttsFull,
        visionAnalyzer: visionFull,
      }),
    ).toBe(false)
  })
})
