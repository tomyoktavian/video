/**
 * Cross-feature contract — Custom AI store used by Highlight Finder UI to
 * read the Vision Analyzer config (reused for the chat-completions call).
 */

export {
  useCustomAiStore,
  getCustomAiVisionAnalyzerConfig,
} from '@/features/settings/stores/custom-ai-store'
