import type { MediaTranscriptModel } from '@/types/storage'
import type { TranscribeOptions, TranscriptSegment } from './types'

export interface MediaTranscriptionModelOption {
  value: MediaTranscriptModel
  label: string
}

/**
 * Minimal surface every transcription stream must expose so the service
 * layer can collect segments and cancel mid-flight without knowing the
 * adapter implementation.
 */
export interface MediaTranscribeStream extends AsyncIterable<TranscriptSegment> {
  collect(): Promise<TranscriptSegment[]>
  cancel(message?: string): void
}

export interface MediaTranscriber {
  transcribe(file: File, runtimeOptions?: TranscribeOptions): MediaTranscribeStream
}

export interface MediaTranscriptionAdapter {
  id: string
  label: string
  defaultModel: MediaTranscriptModel
  modelOptions: readonly MediaTranscriptionModelOption[]
  getModelLabel(model: MediaTranscriptModel): string
  createTranscriber(options?: TranscribeOptions): MediaTranscriber
}
