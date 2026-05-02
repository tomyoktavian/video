/**
 * Cross-feature contract — Custom AI store used by Highlight Finder UI to
 * read the Vision Analyzer config (reused for the chat-completions call)
 * plus the global Settings store for the default subtitle granularity.
 */

export {
  useCustomAiStore,
  getCustomAiVisionAnalyzerConfig,
} from '@/features/settings/stores/custom-ai-store'

export { useSettingsStore } from '@/features/settings/stores/settings-store'
export type { SubtitleGranularity } from '@/features/settings/stores/settings-store'
