/**
 * Cross-feature contract — Custom AI store used by Add Cover to read the
 * Vision Analyzer config (reused for the chat-completions call).
 */

export {
  useCustomAiStore,
  getCustomAiVisionAnalyzerConfig,
} from '@/features/settings/stores/custom-ai-store'
