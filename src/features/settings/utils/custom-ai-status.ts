/**
 * Pure-function checkers for "Custom AI is fully configured" per module.
 *
 * A module is considered configured when its base URL, API key, and selected
 * model are ALL non-empty (whitespace-only counts as empty). Used to drive
 * default provider selection across dialogs (Transcribe, Analyze, TTS engine
 * picker) and to gate the Spoiler Generator entrypoint.
 *
 * Side-effect-free — safe to call from selectors, hooks, and non-React code.
 */

import type {
  CustomAiCaptionMakerConfig,
  CustomAiTextToSpeechConfig,
  CustomAiVisionAnalyzerConfig,
} from '@/infrastructure/storage'

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function isCaptionMakerConfigured(config: CustomAiCaptionMakerConfig): boolean {
  return nonEmpty(config.baseUrl) && nonEmpty(config.apiKey) && nonEmpty(config.model)
}

export function isVisionAnalyzerConfigured(config: CustomAiVisionAnalyzerConfig): boolean {
  return nonEmpty(config.baseUrl) && nonEmpty(config.apiKey) && nonEmpty(config.model)
}

export function isTextToSpeechConfigured(config: CustomAiTextToSpeechConfig): boolean {
  return nonEmpty(config.baseUrl) && nonEmpty(config.apiKey) && nonEmpty(config.model)
}

/** True kalau MINIMAL satu modul Custom AI sudah dikonfigurasi (Caption / Vision / TTS). */
export function isAnyCustomAiConfigured(config: {
  captionMaker: CustomAiCaptionMakerConfig
  textToSpeech: CustomAiTextToSpeechConfig
  visionAnalyzer: CustomAiVisionAnalyzerConfig
}): boolean {
  return (
    isCaptionMakerConfigured(config.captionMaker) ||
    isVisionAnalyzerConfigured(config.visionAnalyzer) ||
    isTextToSpeechConfigured(config.textToSpeech)
  )
}

/** True kalau KETIGA modul Custom AI lengkap — required by Spoiler Generator. */
export function isAllCustomAiConfigured(config: {
  captionMaker: CustomAiCaptionMakerConfig
  textToSpeech: CustomAiTextToSpeechConfig
  visionAnalyzer: CustomAiVisionAnalyzerConfig
}): boolean {
  return (
    isCaptionMakerConfigured(config.captionMaker) &&
    isVisionAnalyzerConfigured(config.visionAnalyzer) &&
    isTextToSpeechConfigured(config.textToSpeech)
  )
}
