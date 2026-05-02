/**
 * Cross-feature contract — Media library service + store used by Spoiler
 * Generator. Used to:
 *   - Look up source-film media metadata (file size, fps, blob URL)
 *   - Trigger transcription for the source film and the TTS narration
 *   - Save TTS narration audio to the project media library
 *   - Build per-word subtitle text items (shared with Highlight Finder)
 */

export { mediaLibraryService } from '@/features/media-library/services/media-library-service'
export { mediaTranscriptionService } from '@/features/media-library/services/media-transcription-service'
export { useMediaLibraryStore } from '@/features/media-library'
export {
  subdivideSegmentIntoWordGroups,
  buildSubtitleTextItem,
} from '@/features/media-library/utils/caption-items'
export type { SubtitleTextItemInput } from '@/features/media-library/utils/caption-items'
