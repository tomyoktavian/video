/**
 * Workspace-scoped Custom AI configuration.
 *
 * Stored at `{workspace}/custom-ai.json`. The Custom AI feature targets
 * OpenAI-compatible HTTP APIs (transcription today, more features later)
 * and the API key in particular should not live in the localStorage-backed
 * settings store — keeping this file in the workspace folder ties the
 * secret to the user's chosen disk location.
 */

import { createLogger } from '@/shared/logging/logger'

import { readJson, writeJsonAtomic } from './fs-primitives'
import { customAiPath } from './paths'
import { requireWorkspaceRoot } from './root'

const logger = createLogger('WorkspaceFS:CustomAi')

export interface CustomAiCachedModel {
  id: string
  label?: string
}

export interface CustomAiCaptionMakerConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Source-language hint passed to /audio/transcriptions. '' = auto. */
  language: string
  cachedModels: ReadonlyArray<CustomAiCachedModel>
  lastLoadedAt: number | null
}

export interface CustomAiTextToSpeechConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Voice name passed to /audio/speech. '' falls back to 'alloy' at call time. */
  voice: string
  /**
   * Target-language hint forwarded to /audio/speech as `language`. '' = auto
   * (let the TTS model detect from the input text — OpenAI's tts-1 does this
   * natively for mixed-language input). No translation is performed.
   */
  language: string
  cachedModels: ReadonlyArray<CustomAiCachedModel>
  /**
   * Voices returned by the provider's `/audio/voices` endpoint, when supported.
   * Empty list = the server doesn't expose voice listing — UI falls back to
   * a free-text input.
   */
  cachedVoices: ReadonlyArray<CustomAiCachedModel>
  lastLoadedAt: number | null
}

export interface CustomAiVisionAnalyzerConfig {
  baseUrl: string
  apiKey: string
  model: string
  /**
   * Override the built-in system prompt sent to /chat/completions for the
   * Highlight Finder feature. Empty string = use the default prompt shipped
   * with the app. The user message (clips + targets) is always appended
   * automatically and does not need to live in this prompt.
   */
  highlightFinderPrompt: string
  /**
   * Override the built-in system prompt sent to /chat/completions for the
   * Add Cover feature (Vlog-style title text generation for compound clips).
   * Empty string = use the default prompt. The user message (transcript or
   * free-form context) is appended automatically by the adapter.
   */
  coverFinderPrompt: string
  /**
   * Override the built-in system prompt sent to /chat/completions for the
   * Auto Spoiler Generator's Script Writer (full-transcript narrative
   * generation for movie spoilers). Empty string = use the default prompt.
   * The user message (transcript + target duration + language directive) is
   * appended automatically by the adapter.
   */
  scriptWriterPrompt: string
  cachedModels: ReadonlyArray<CustomAiCachedModel>
  lastLoadedAt: number | null
}

export interface CustomAiConfig {
  captionMaker: CustomAiCaptionMakerConfig
  textToSpeech: CustomAiTextToSpeechConfig
  visionAnalyzer: CustomAiVisionAnalyzerConfig
}

export const DEFAULT_CUSTOM_AI_CONFIG: CustomAiConfig = {
  captionMaker: {
    baseUrl: '',
    apiKey: '',
    model: '',
    language: '',
    cachedModels: [],
    lastLoadedAt: null,
  },
  textToSpeech: {
    baseUrl: '',
    apiKey: '',
    model: '',
    voice: '',
    language: '',
    cachedModels: [],
    cachedVoices: [],
    lastLoadedAt: null,
  },
  visionAnalyzer: {
    baseUrl: '',
    apiKey: '',
    model: '',
    highlightFinderPrompt: '',
    coverFinderPrompt: '',
    scriptWriterPrompt: '',
    cachedModels: [],
    lastLoadedAt: null,
  },
}

function normalizeCachedModels(value: unknown): CustomAiCachedModel[] {
  if (!Array.isArray(value)) return []
  const out: CustomAiCachedModel[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    const label = (entry as { label?: unknown }).label
    if (typeof id !== 'string' || id.length === 0) continue
    out.push({ id, ...(typeof label === 'string' ? { label } : {}) })
  }
  return out
}

function normalizeCaptionMaker(value: unknown): CustomAiCaptionMakerConfig {
  const raw = (value ?? {}) as Partial<CustomAiCaptionMakerConfig>
  const lastLoadedAtRaw = (raw as { lastLoadedAt?: unknown }).lastLoadedAt
  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    language: typeof raw.language === 'string' ? raw.language : '',
    cachedModels: normalizeCachedModels(raw.cachedModels),
    lastLoadedAt:
      typeof lastLoadedAtRaw === 'number' && Number.isFinite(lastLoadedAtRaw)
        ? lastLoadedAtRaw
        : null,
  }
}

function normalizeTextToSpeech(value: unknown): CustomAiTextToSpeechConfig {
  const raw = (value ?? {}) as Partial<CustomAiTextToSpeechConfig>
  const lastLoadedAtRaw = (raw as { lastLoadedAt?: unknown }).lastLoadedAt
  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    voice: typeof raw.voice === 'string' ? raw.voice : '',
    language: typeof raw.language === 'string' ? raw.language : '',
    cachedModels: normalizeCachedModels(raw.cachedModels),
    cachedVoices: normalizeCachedModels(raw.cachedVoices),
    lastLoadedAt:
      typeof lastLoadedAtRaw === 'number' && Number.isFinite(lastLoadedAtRaw)
        ? lastLoadedAtRaw
        : null,
  }
}

function normalizeVisionAnalyzer(value: unknown): CustomAiVisionAnalyzerConfig {
  const raw = (value ?? {}) as Partial<CustomAiVisionAnalyzerConfig>
  const lastLoadedAtRaw = (raw as { lastLoadedAt?: unknown }).lastLoadedAt
  return {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    highlightFinderPrompt:
      typeof raw.highlightFinderPrompt === 'string' ? raw.highlightFinderPrompt : '',
    coverFinderPrompt: typeof raw.coverFinderPrompt === 'string' ? raw.coverFinderPrompt : '',
    scriptWriterPrompt: typeof raw.scriptWriterPrompt === 'string' ? raw.scriptWriterPrompt : '',
    cachedModels: normalizeCachedModels(raw.cachedModels),
    lastLoadedAt:
      typeof lastLoadedAtRaw === 'number' && Number.isFinite(lastLoadedAtRaw)
        ? lastLoadedAtRaw
        : null,
  }
}

function normalizeConfig(value: unknown): CustomAiConfig {
  const raw = (value ?? {}) as Partial<CustomAiConfig>
  return {
    captionMaker: normalizeCaptionMaker(raw.captionMaker),
    textToSpeech: normalizeTextToSpeech(raw.textToSpeech),
    visionAnalyzer: normalizeVisionAnalyzer(raw.visionAnalyzer),
  }
}

export async function loadCustomAiConfig(): Promise<CustomAiConfig> {
  try {
    const root = requireWorkspaceRoot()
    const data = await readJson<unknown>(root, customAiPath())
    if (!data) return DEFAULT_CUSTOM_AI_CONFIG
    return normalizeConfig(data)
  } catch (error) {
    logger.error('loadCustomAiConfig failed', error)
    return DEFAULT_CUSTOM_AI_CONFIG
  }
}

export async function saveCustomAiConfig(config: CustomAiConfig): Promise<void> {
  try {
    const root = requireWorkspaceRoot()
    await writeJsonAtomic(root, customAiPath(), normalizeConfig(config))
  } catch (error) {
    logger.error('saveCustomAiConfig failed', error)
    throw new Error('Failed to save Custom AI config')
  }
}
