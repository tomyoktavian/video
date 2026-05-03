/**
 * Cross-feature contract — Add Cover (compound-cover) components and
 * constants used by the Editor feature.
 */

export { AddCoverDialog } from '@/features/compound-cover/components/add-cover-dialog'
export {
  DEFAULT_COVER_FINDER_SYSTEM_PROMPT,
  DEFAULT_POSTER_PROMPT_SYSTEM_PROMPT,
  POSTER_CAST_OPTIONS,
  POSTER_MOOD_OPTIONS,
  POSTER_QUALITY_OPTIONS,
  POSTER_STYLE_OPTIONS,
  buildFreeformImagePrompt,
  resolvePosterQualityApiValue,
  type PosterCastValue,
  type PosterMoodValue,
  type PosterQualityValue,
  type PosterStyleValue,
} from '@/features/compound-cover/system-prompt'
export { generateCoverImage } from '@/features/compound-cover/openai-compatible-image-adapter'
export type { CoverImageRequest, CoverImageResponse } from '@/features/compound-cover/types'
