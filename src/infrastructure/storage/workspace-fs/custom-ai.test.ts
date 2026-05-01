import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    event: vi.fn(),
    startEvent: () => ({ set: vi.fn(), merge: vi.fn(), success: vi.fn(), failure: vi.fn() }),
    child: vi.fn(),
    setLevel: vi.fn(),
  }),
  createOperationId: () => 'op-test',
}))

import { DEFAULT_CUSTOM_AI_CONFIG, loadCustomAiConfig, saveCustomAiConfig } from './custom-ai'
import { setWorkspaceRoot } from './root'
import { asHandle, createRoot, readFileText } from './__tests__/in-memory-handle'
import { __resetKeyLocksForTesting } from './with-key-lock'

beforeEach(() => {
  setWorkspaceRoot(null)
  __resetKeyLocksForTesting()
})

afterEach(() => {
  setWorkspaceRoot(null)
  __resetKeyLocksForTesting()
})

describe('workspace-fs custom-ai', () => {
  it('returns defaults when no config file exists', async () => {
    setWorkspaceRoot(asHandle(createRoot()))
    const config = await loadCustomAiConfig()
    expect(config).toEqual(DEFAULT_CUSTOM_AI_CONFIG)
  })

  it('round-trips a saved config', async () => {
    const root = createRoot()
    setWorkspaceRoot(asHandle(root))

    await saveCustomAiConfig({
      captionMaker: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'whisper-1',
        language: 'id',
        cachedModels: [{ id: 'whisper-1', label: 'Whisper v1' }, { id: 'gpt-4o-transcribe' }],
        lastLoadedAt: 1700000000000,
      },
      textToSpeech: DEFAULT_CUSTOM_AI_CONFIG.textToSpeech,
      visionAnalyzer: DEFAULT_CUSTOM_AI_CONFIG.visionAnalyzer,
    })

    const text = await readFileText(root, 'custom-ai.json')
    expect(text).not.toBeNull()
    expect(JSON.parse(text!).captionMaker.apiKey).toBe('sk-test')

    const reloaded = await loadCustomAiConfig()
    expect(reloaded.captionMaker.baseUrl).toBe('https://api.example.com/v1')
    expect(reloaded.captionMaker.cachedModels).toEqual([
      { id: 'whisper-1', label: 'Whisper v1' },
      { id: 'gpt-4o-transcribe' },
    ])
    expect(reloaded.captionMaker.lastLoadedAt).toBe(1700000000000)
  })

  it('drops malformed cached model entries on load', async () => {
    const root = createRoot()
    setWorkspaceRoot(asHandle(root))

    // Hand-write a payload with garbage entries.
    await saveCustomAiConfig({
      captionMaker: {
        ...DEFAULT_CUSTOM_AI_CONFIG.captionMaker,
        cachedModels: [
          { id: 'whisper-1' },
          // @ts-expect-error garbage at runtime
          { id: 42 },
          // @ts-expect-error garbage at runtime
          {},
          { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
        ],
      },
      textToSpeech: DEFAULT_CUSTOM_AI_CONFIG.textToSpeech,
      visionAnalyzer: DEFAULT_CUSTOM_AI_CONFIG.visionAnalyzer,
    })

    const reloaded = await loadCustomAiConfig()
    expect(reloaded.captionMaker.cachedModels).toEqual([
      { id: 'whisper-1' },
      { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
    ])
  })

  it('round-trips a saved textToSpeech config', async () => {
    const root = createRoot()
    setWorkspaceRoot(asHandle(root))

    await saveCustomAiConfig({
      captionMaker: DEFAULT_CUSTOM_AI_CONFIG.captionMaker,
      textToSpeech: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-tts',
        model: 'tts-1',
        voice: 'alloy',
        language: 'id',
        cachedModels: [{ id: 'tts-1', label: 'TTS-1' }, { id: 'tts-1-hd' }],
        cachedVoices: [{ id: 'alloy' }, { id: 'echo', label: 'Echo' }],
        lastLoadedAt: 1700000001000,
      },
      visionAnalyzer: DEFAULT_CUSTOM_AI_CONFIG.visionAnalyzer,
    })

    const text = await readFileText(root, 'custom-ai.json')
    expect(text).not.toBeNull()
    const parsed = JSON.parse(text!)
    expect(parsed.textToSpeech.apiKey).toBe('sk-tts')
    expect(parsed.textToSpeech.voice).toBe('alloy')

    const reloaded = await loadCustomAiConfig()
    expect(reloaded.textToSpeech.baseUrl).toBe('https://api.openai.com/v1')
    expect(reloaded.textToSpeech.model).toBe('tts-1')
    expect(reloaded.textToSpeech.voice).toBe('alloy')
    expect(reloaded.textToSpeech.language).toBe('id')
    expect(reloaded.textToSpeech.cachedModels).toEqual([
      { id: 'tts-1', label: 'TTS-1' },
      { id: 'tts-1-hd' },
    ])
    expect(reloaded.textToSpeech.cachedVoices).toEqual([
      { id: 'alloy' },
      { id: 'echo', label: 'Echo' },
    ])
    expect(reloaded.textToSpeech.lastLoadedAt).toBe(1700000001000)
  })

  it('defaults textToSpeech when on-disk config omits the slice', async () => {
    const root = createRoot()
    setWorkspaceRoot(asHandle(root))

    // Simulate an older config file that only has `captionMaker`.
    const handle = await root.getFileHandle('custom-ai.json', { create: true })
    const writable = await handle.createWritable()
    await writable.write(
      JSON.stringify({
        captionMaker: {
          ...DEFAULT_CUSTOM_AI_CONFIG.captionMaker,
          baseUrl: 'https://legacy.example.com/v1',
          apiKey: 'sk-legacy',
        },
      }),
    )
    await writable.close()

    const reloaded = await loadCustomAiConfig()
    expect(reloaded.captionMaker.baseUrl).toBe('https://legacy.example.com/v1')
    expect(reloaded.captionMaker.apiKey).toBe('sk-legacy')
    expect(reloaded.textToSpeech).toEqual(DEFAULT_CUSTOM_AI_CONFIG.textToSpeech)
  })

  it('round-trips a saved visionAnalyzer config', async () => {
    const root = createRoot()
    setWorkspaceRoot(asHandle(root))

    await saveCustomAiConfig({
      captionMaker: DEFAULT_CUSTOM_AI_CONFIG.captionMaker,
      textToSpeech: DEFAULT_CUSTOM_AI_CONFIG.textToSpeech,
      visionAnalyzer: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-vision',
        model: 'gpt-4o-mini',
        highlightFinderPrompt: 'Pick only highlights that include laughter.',
        coverFinderPrompt: '',
        cachedModels: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o', label: 'GPT-4o' }],
        lastLoadedAt: 1700000002000,
      },
    })

    const reloaded = await loadCustomAiConfig()
    expect(reloaded.visionAnalyzer.baseUrl).toBe('https://api.openai.com/v1')
    expect(reloaded.visionAnalyzer.apiKey).toBe('sk-vision')
    expect(reloaded.visionAnalyzer.model).toBe('gpt-4o-mini')
    expect(reloaded.visionAnalyzer.highlightFinderPrompt).toBe(
      'Pick only highlights that include laughter.',
    )
    expect(reloaded.visionAnalyzer.cachedModels).toEqual([
      { id: 'gpt-4o-mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
    ])
    expect(reloaded.visionAnalyzer.lastLoadedAt).toBe(1700000002000)
  })

  it('defaults visionAnalyzer when on-disk config omits the slice', async () => {
    const root = createRoot()
    setWorkspaceRoot(asHandle(root))

    const handle = await root.getFileHandle('custom-ai.json', { create: true })
    const writable = await handle.createWritable()
    await writable.write(
      JSON.stringify({
        captionMaker: { ...DEFAULT_CUSTOM_AI_CONFIG.captionMaker, baseUrl: 'https://x/v1' },
        textToSpeech: DEFAULT_CUSTOM_AI_CONFIG.textToSpeech,
      }),
    )
    await writable.close()

    const reloaded = await loadCustomAiConfig()
    expect(reloaded.captionMaker.baseUrl).toBe('https://x/v1')
    expect(reloaded.visionAnalyzer).toEqual(DEFAULT_CUSTOM_AI_CONFIG.visionAnalyzer)
  })
})
