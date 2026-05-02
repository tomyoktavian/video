/**
 * Cross-layer contract — workspace-fs transcript reader. Used by the Script
 * Writer service to load the full transcript before issuing the LLM call.
 */

export { getTranscript } from '@/infrastructure/storage'
export type { MediaTranscript, MediaTranscriptSegment } from '@/types/storage'
