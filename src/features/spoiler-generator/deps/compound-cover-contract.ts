/**
 * Cross-feature contract — Compound Cover service. Used by Spoiler
 * Generator's cover insertion stage to render a frame, persist it, and
 * insert a Vlog-style title card at the head of the spoiler compound.
 *
 * Also re-exports the AI image generation surface (form helpers, prompt
 * builder, image adapter, poster option presets) so the Spoiler Generator
 * dialog can replicate the "Generate cover with AI" flow inline.
 */

export { insertCover } from '@/features/compound-cover/insert-cover-action'
export { renderCoverFrame, persistCoverFrame } from '@/features/compound-cover/frame-extraction'

export {
  buildCoverImagePromptFromForm,
  summariseCoverTranscript,
} from '@/features/compound-cover/cover-service'

export { generateCoverImage } from '@/features/compound-cover/openai-compatible-image-adapter'
export type { CoverImageRequest, CoverImageResponse } from '@/features/compound-cover/types'

export {
  POSTER_CAST_OPTIONS,
  POSTER_MOOD_OPTIONS,
  POSTER_QUALITY_OPTIONS,
  POSTER_STYLE_OPTIONS,
  resolvePosterQualityApiValue,
  type PosterCastValue,
  type PosterMoodValue,
  type PosterQualityValue,
  type PosterStyleValue,
} from '@/features/compound-cover/system-prompt'

export { AiImagePanel } from '@/features/compound-cover/components/ai-image-panel'
export type {
  AiImagePanelProps,
  AiImagePanelDurationField,
  AiImagePromptMode,
  AiImageFormSnapshot,
  AiImageGeneratedPayload,
} from '@/features/compound-cover/components/ai-image-panel'
