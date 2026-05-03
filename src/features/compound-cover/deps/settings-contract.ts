/**
 * Cross-feature contract — Custom AI store used by Add Cover to read the
 * Vision Analyzer config (reused for the chat-completions call) and the
 * Image Generator config (used by the cover-image adapter).
 */

export {
  useCustomAiStore,
  getCustomAiVisionAnalyzerConfig,
  getCustomAiImageGeneratorConfig,
} from '@/features/settings/stores/custom-ai-store'
