/**
 * Cross-feature contract — analysis infrastructure used by media-library.
 *
 * Split out of `analysis.ts` so additional analysis imports (embeddings,
 * future providers) stay in one auditable place for the boundary checker.
 */

export {
  captionVideo,
  captionImage,
  captionVideoWith,
  captionImageWith,
  DEFAULT_MEDIA_CAPTIONING_PROVIDER_ID,
  OPENAI_COMPATIBLE_VISION_PROVIDER_ID,
} from '@/infrastructure/analysis'
export type { MediaCaption, CaptioningProgress, CaptioningOptions } from '@/infrastructure/analysis'
export {
  embeddingsProvider,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_DIM,
  clipProvider,
  CLIP_MODEL_ID,
  CLIP_EMBEDDING_DIM,
  buildEmbeddingText,
  extractDominantColors,
  extractDominantColorPhrase,
} from '@/infrastructure/analysis'
export type {
  EmbeddingsOptions,
  EmbeddingsProgress,
  EmbeddingsProvider,
  BuildEmbeddingTextInput,
  TranscriptSegment,
  PaletteEntry,
} from '@/infrastructure/analysis'
