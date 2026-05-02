/**
 * Cross-feature contract — Custom AI store used by Spoiler Generator to
 * read the Vision Analyzer config (chat-completions endpoint reused for
 * the Script Writer LLM call) and the Text-to-Speech config (for narration).
 *
 * Also re-exports the global settings store so the spoiler pipeline can read
 * `defaultSubtitleGranularity` (consistent with Highlight Finder behaviour).
 */

export {
  useCustomAiStore,
  getCustomAiCaptionMakerConfig,
  getCustomAiVisionAnalyzerConfig,
  getCustomAiTextToSpeechConfig,
  isCaptionMakerConfigured,
  isVisionAnalyzerConfigured,
  isTextToSpeechConfigured,
  isAllCustomAiConfigured,
} from '@/features/settings/stores/custom-ai-store'

export type {
  CustomAiCaptionMakerConfig,
  CustomAiVisionAnalyzerConfig,
  CustomAiTextToSpeechConfig,
} from '@/features/settings/stores/custom-ai-store'

export { useSettingsStore } from '@/features/settings/stores/settings-store'
export type { SubtitleGranularity } from '@/features/settings/stores/settings-store'
