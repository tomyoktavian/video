/**
 * Custom AI store — workspace-backed (NOT localStorage).
 *
 * Mirrors the in-memory shape of `CustomAiConfig` for reactive UI; writes
 * propagate to `{workspace}/custom-ai.json` via `saveCustomAiConfig`.
 *
 * Hydration is explicit: `hydrateCustomAiStore()` runs from WorkspaceGate
 * once the workspace root is set and `bootstrapWorkspace` has finished.
 */

import { create } from 'zustand'

import {
  DEFAULT_CUSTOM_AI_CONFIG,
  loadCustomAiConfig,
  saveCustomAiConfig,
  type CustomAiCachedModel,
  type CustomAiCaptionMakerConfig,
  type CustomAiConfig,
  type CustomAiImageGeneratorConfig,
  type CustomAiTextToSpeechConfig,
  type CustomAiVisionAnalyzerConfig,
} from '@/infrastructure/storage'
import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('CustomAiStore')

interface CustomAiActions {
  setCaptionMaker: (partial: Partial<CustomAiCaptionMakerConfig>) => void
  resetCaptionMaker: () => void
  setTextToSpeech: (partial: Partial<CustomAiTextToSpeechConfig>) => void
  resetTextToSpeech: () => void
  setVisionAnalyzer: (partial: Partial<CustomAiVisionAnalyzerConfig>) => void
  resetVisionAnalyzer: () => void
  setImageGenerator: (partial: Partial<CustomAiImageGeneratorConfig>) => void
  resetImageGenerator: () => void
  replaceConfig: (next: CustomAiConfig) => void
}

type CustomAiStore = CustomAiConfig & CustomAiActions & { hydrated: boolean }

function persistAll(
  patch: Partial<
    Pick<CustomAiConfig, 'captionMaker' | 'textToSpeech' | 'visionAnalyzer' | 'imageGenerator'>
  >,
  current: CustomAiConfig,
  context: string,
) {
  const next: CustomAiConfig = {
    captionMaker: patch.captionMaker ?? current.captionMaker,
    textToSpeech: patch.textToSpeech ?? current.textToSpeech,
    visionAnalyzer: patch.visionAnalyzer ?? current.visionAnalyzer,
    imageGenerator: patch.imageGenerator ?? current.imageGenerator,
  }
  void saveCustomAiConfig(next).catch((error) => {
    logger.warn(`Failed to persist ${context}`, error)
  })
}

export const useCustomAiStore = create<CustomAiStore>()((set, get) => ({
  ...DEFAULT_CUSTOM_AI_CONFIG,
  hydrated: false,

  setCaptionMaker: (partial) => {
    const next: CustomAiCaptionMakerConfig = { ...get().captionMaker, ...partial }
    set({ captionMaker: next })
    persistAll({ captionMaker: next }, get(), 'captionMaker change')
  },

  resetCaptionMaker: () => {
    const next = DEFAULT_CUSTOM_AI_CONFIG.captionMaker
    set({ captionMaker: next })
    persistAll({ captionMaker: next }, get(), 'captionMaker reset')
  },

  setTextToSpeech: (partial) => {
    const next: CustomAiTextToSpeechConfig = { ...get().textToSpeech, ...partial }
    set({ textToSpeech: next })
    persistAll({ textToSpeech: next }, get(), 'textToSpeech change')
  },

  resetTextToSpeech: () => {
    const next = DEFAULT_CUSTOM_AI_CONFIG.textToSpeech
    set({ textToSpeech: next })
    persistAll({ textToSpeech: next }, get(), 'textToSpeech reset')
  },

  setVisionAnalyzer: (partial) => {
    const next: CustomAiVisionAnalyzerConfig = { ...get().visionAnalyzer, ...partial }
    set({ visionAnalyzer: next })
    persistAll({ visionAnalyzer: next }, get(), 'visionAnalyzer change')
  },

  resetVisionAnalyzer: () => {
    const next = DEFAULT_CUSTOM_AI_CONFIG.visionAnalyzer
    set({ visionAnalyzer: next })
    persistAll({ visionAnalyzer: next }, get(), 'visionAnalyzer reset')
  },

  setImageGenerator: (partial) => {
    const next: CustomAiImageGeneratorConfig = { ...get().imageGenerator, ...partial }
    set({ imageGenerator: next })
    persistAll({ imageGenerator: next }, get(), 'imageGenerator change')
  },

  resetImageGenerator: () => {
    const next = DEFAULT_CUSTOM_AI_CONFIG.imageGenerator
    set({ imageGenerator: next })
    persistAll({ imageGenerator: next }, get(), 'imageGenerator reset')
  },

  replaceConfig: (next) => {
    set({ ...next, hydrated: true })
  },
}))

/** Read the on-disk Custom AI config and replace the store. */
export async function hydrateCustomAiStore(): Promise<void> {
  try {
    const config = await loadCustomAiConfig()
    // Stale `custom:<id>` voice values from the removed Custom Voice Library
    // would otherwise be sent literally to the TTS provider. Reset to empty
    // so the service falls back to the default voice.
    if (config.textToSpeech.voice.startsWith('custom:')) {
      const sanitized: CustomAiConfig = {
        ...config,
        textToSpeech: { ...config.textToSpeech, voice: '' },
      }
      useCustomAiStore.getState().replaceConfig(sanitized)
      void saveCustomAiConfig(sanitized).catch((error) => {
        logger.warn('persist sanitized customAi config failed', error)
      })
      return
    }
    useCustomAiStore.getState().replaceConfig(config)
  } catch (error) {
    logger.warn('hydrateCustomAiStore failed', error)
    useCustomAiStore.setState({ hydrated: true })
  }
}

/** Synchronous getter for non-React code (the transcription adapter). */
export function getCustomAiCaptionMakerConfig(): CustomAiCaptionMakerConfig {
  return useCustomAiStore.getState().captionMaker
}

/** Synchronous getter for non-React code (the custom TTS service). */
export function getCustomAiTextToSpeechConfig(): CustomAiTextToSpeechConfig {
  return useCustomAiStore.getState().textToSpeech
}

/** Synchronous getter for non-React code (vision provider, highlight finder). */
export function getCustomAiVisionAnalyzerConfig(): CustomAiVisionAnalyzerConfig {
  return useCustomAiStore.getState().visionAnalyzer
}

/** Synchronous getter for non-React code (cover-image generator adapter). */
export function getCustomAiImageGeneratorConfig(): CustomAiImageGeneratorConfig {
  return useCustomAiStore.getState().imageGenerator
}

export type {
  CustomAiCachedModel,
  CustomAiCaptionMakerConfig,
  CustomAiConfig,
  CustomAiImageGeneratorConfig,
  CustomAiTextToSpeechConfig,
  CustomAiVisionAnalyzerConfig,
}

export {
  isAllCustomAiConfigured,
  isAnyCustomAiConfigured,
  isCaptionMakerConfigured,
  isImageGeneratorConfigured,
  isTextToSpeechConfigured,
  isVisionAnalyzerConfigured,
} from '../utils/custom-ai-status'
