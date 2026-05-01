/**
 * Adapter — re-exports settings store for media-library consumption.
 */

export {
  useSettingsStore,
  resolveCaptioningIntervalSec,
  DEFAULT_CAPTIONING_INTERVAL_SECONDS,
} from '@/features/settings/stores/settings-store'
export type { CaptioningIntervalUnit } from '@/features/settings/stores/settings-store'
export {
  useCustomAiStore,
  getCustomAiCaptionMakerConfig,
  getCustomAiVisionAnalyzerConfig,
} from '@/features/settings/stores/custom-ai-store'
export type {
  CustomAiCachedModel,
  CustomAiCaptionMakerConfig,
  CustomAiVisionAnalyzerConfig,
} from '@/features/settings/stores/custom-ai-store'
