/**
 * OpenAI-compatible transcription adapter.
 *
 * Sends audio to `POST {baseUrl}/audio/transcriptions` with `verbose_json`
 * and word-level timestamps. Works with OpenAI, Groq, Together, Fal, and
 * any compatible self-hosted whisper.cpp / faster-whisper server.
 *
 * Configuration (base URL, API key, model, language) is read at call time
 * from the workspace-backed `useCustomAiStore` so the user's saved config
 * always wins. The `language` field is a *source-language hint* — output
 * stays in the source language, no translation.
 */

import { getCustomAiCaptionMakerConfig } from '@/features/media-library/deps/settings-contract'
import { createLogger } from '@/shared/logging/logger'

import type {
  MediaTranscribeStream,
  MediaTranscriber,
  MediaTranscriptionAdapter,
  MediaTranscriptionModelOption,
} from './adapter-types'
import { extractAudioForUpload } from './extract-audio'
import type { TranscribeOptions, TranscriptSegment, TranscriptWord } from './types'

export const OPENAI_COMPATIBLE_TRANSCRIPTION_ADAPTER_ID = 'openai-compatible'

const logger = createLogger('OpenAiCompatibleAdapter')

/**
 * Always extract for video. For audio-only sources, extract once we cross
 * this threshold so common 25 MB API caps stay safe with headroom for
 * multipart overhead. 22 MB is conservative.
 */
const AUDIO_EXTRACTION_SIZE_THRESHOLD_BYTES = 22 * 1024 * 1024

interface OpenAiVerboseSegment {
  text?: string
  start?: number
  end?: number
  words?: OpenAiVerboseWord[]
}

interface OpenAiVerboseWord {
  word?: string
  start?: number
  end?: number
}

interface OpenAiVerboseResponse {
  text?: string
  segments?: OpenAiVerboseSegment[]
  words?: OpenAiVerboseWord[]
}

/**
 * Group of word boundaries used to break a flat word list into pseudo-segments
 * when the provider returns words but no segments (e.g. some Groq/Together
 * configurations). A new segment starts when:
 *   - the previous word ended with sentence punctuation (`.`, `!`, `?`),
 *   - or the gap between consecutive words exceeds {@link WORDS_ONLY_GAP_SECONDS}.
 */
const WORDS_ONLY_GAP_SECONDS = 0.6
const SENTENCE_END_PATTERN = /[.!?]\s*$/

function normalizeWords(raw: readonly OpenAiVerboseWord[] | undefined): TranscriptWord[] {
  if (!raw) return []
  const result: TranscriptWord[] = []
  for (const word of raw) {
    const text = typeof word.word === 'string' ? word.word : ''
    if (text.trim().length === 0) continue
    const start = typeof word.start === 'number' ? word.start : 0
    const end = typeof word.end === 'number' ? word.end : start
    if (end < start) continue
    result.push({ text, start, end })
  }
  return result
}

function groupWordsIntoPseudoSegments(words: readonly TranscriptWord[]): TranscriptSegment[] {
  if (words.length === 0) return []
  const segments: TranscriptSegment[] = []
  let bucket: TranscriptWord[] = []

  const flush = () => {
    if (bucket.length === 0) return
    const first = bucket[0]!
    const last = bucket.at(-1)!
    segments.push({
      text: bucket
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      start: first.start,
      end: last.end,
      words: bucket,
    })
    bucket = []
  }

  for (const word of words) {
    const previous = bucket.at(-1)
    if (previous) {
      const gap = word.start - previous.end
      if (gap > WORDS_ONLY_GAP_SECONDS || SENTENCE_END_PATTERN.test(previous.text)) {
        flush()
      }
    }
    bucket.push(word)
  }
  flush()
  return segments.filter((seg) => seg.text.length > 0 && seg.end >= seg.start)
}

function attachWordsToSegment(
  segment: OpenAiVerboseSegment,
  topLevelWords: readonly TranscriptWord[],
): TranscriptWord[] | undefined {
  const inline = normalizeWords(segment.words)
  if (inline.length > 0) return inline

  if (
    topLevelWords.length === 0 ||
    typeof segment.start !== 'number' ||
    typeof segment.end !== 'number'
  ) {
    return undefined
  }

  const matched = topLevelWords.filter(
    (word) => word.start >= segment.start! - 0.001 && word.start < segment.end!,
  )
  return matched.length > 0 ? matched : undefined
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function buildTranscriptionsUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/audio/transcriptions`
}

function parseSegments(payload: OpenAiVerboseResponse): TranscriptSegment[] {
  const topLevelWords = normalizeWords(payload.words)

  if (Array.isArray(payload.segments) && payload.segments.length > 0) {
    return payload.segments
      .map((segment) => {
        const text = typeof segment.text === 'string' ? segment.text : ''
        const start = typeof segment.start === 'number' ? segment.start : 0
        const end = typeof segment.end === 'number' ? segment.end : 0
        const words = attachWordsToSegment(segment, topLevelWords)
        return {
          text,
          start,
          end,
          ...(words ? { words } : {}),
        }
      })
      .filter((segment) => segment.text.trim().length > 0 && segment.end >= segment.start)
  }

  if (topLevelWords.length > 0) {
    return groupWordsIntoPseudoSegments(topLevelWords)
  }

  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return [{ text: payload.text, start: 0, end: 0 }]
  }

  return []
}

class OpenAiCompatibleTranscribeStream implements MediaTranscribeStream {
  private readonly file: File
  private readonly options: TranscribeOptions
  private controller: AbortController | null = null
  private resultPromise: Promise<TranscriptSegment[]> | null = null
  private cancelled = false
  private cancelMessage = 'Transcription cancelled'

  constructor(file: File, options: TranscribeOptions) {
    this.file = file
    this.options = options
  }

  async collect(): Promise<TranscriptSegment[]> {
    if (!this.resultPromise) {
      this.resultPromise = this.run()
    }
    return this.resultPromise
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TranscriptSegment> {
    const segments = await this.collect()
    for (const segment of segments) {
      yield segment
    }
  }

  cancel(message = 'Transcription cancelled'): void {
    this.cancelled = true
    this.cancelMessage = message
    this.controller?.abort()
  }

  /**
   * Decide whether to upload the file as-is or to extract a compact MP3
   * audio track first. Video sources always get extracted (they include
   * frame data the API doesn't need); audio sources only when they cross
   * the API size cap with headroom for multipart overhead.
   */
  private async prepareUploadPayload(): Promise<{ blob: Blob; fileName: string }> {
    const isVideo = this.file.type.startsWith('video/')
    const overSizeLimit = this.file.size > AUDIO_EXTRACTION_SIZE_THRESHOLD_BYTES
    if (!isVideo && !overSizeLimit) {
      return { blob: this.file, fileName: this.file.name }
    }

    try {
      const extracted = await extractAudioForUpload(this.file, this.file.name, {
        signal: this.controller?.signal,
      })
      logger.info('Extracted audio for Custom AI upload', {
        sourceBytes: this.file.size,
        sourceMime: this.file.type,
        outputBytes: extracted.blob.size,
        outputMime: extracted.mimeType,
      })
      return { blob: extracted.blob, fileName: extracted.fileName }
    } catch (error) {
      if (this.cancelled) throw new Error(this.cancelMessage)
      // For pure-audio sources we can fall back to the original blob — the
      // API may still accept it. Video sources have no useful fallback.
      if (!isVideo && !overSizeLimit) {
        logger.warn('Audio extraction failed, falling back to original audio file', error)
        return { blob: this.file, fileName: this.file.name }
      }
      throw error instanceof Error
        ? new Error(`Failed to extract audio for upload: ${error.message}`)
        : new Error('Failed to extract audio for upload')
    }
  }

  private async run(): Promise<TranscriptSegment[]> {
    if (this.cancelled) throw new Error(this.cancelMessage)

    const config = getCustomAiCaptionMakerConfig()
    if (!config.baseUrl) throw new Error('Custom AI base URL is not configured')
    if (!config.apiKey) throw new Error('Custom AI API key is not configured')

    const requestedModel = (this.options.model ?? config.model ?? '').toString().trim()
    if (!requestedModel) {
      throw new Error('Custom AI model is not selected — load and pick a model in Settings → AI')
    }

    this.options.onProgress?.({ stage: 'loading', progress: 0 })

    this.controller = new AbortController()

    const uploadPayload = await this.prepareUploadPayload()
    if (this.cancelled) throw new Error(this.cancelMessage)

    const form = new FormData()
    form.append('file', uploadPayload.blob, uploadPayload.fileName)
    form.append('model', requestedModel)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')

    const language = (this.options.language ?? config.language ?? '').trim()
    if (language) form.append('language', language)

    let response: Response
    try {
      response = await fetch(buildTranscriptionsUrl(config.baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: this.controller.signal,
      })
    } catch (error) {
      if (this.cancelled) throw new Error(this.cancelMessage)
      throw error instanceof Error ? error : new Error(String(error))
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `Custom AI transcription failed (${response.status})${detail ? `: ${detail}` : ''}`,
      )
    }

    let payload: OpenAiVerboseResponse
    try {
      payload = (await response.json()) as OpenAiVerboseResponse
    } catch (error) {
      throw new Error(
        `Custom AI returned a non-JSON response: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (this.cancelled) throw new Error(this.cancelMessage)

    const segments = parseSegments(payload)
    this.options.onProgress?.({ stage: 'transcribing', progress: 1 })
    for (const segment of segments) {
      this.options.onSegment?.(segment)
    }
    return segments
  }
}

class OpenAiCompatibleTranscriber implements MediaTranscriber {
  private readonly defaultOptions: TranscribeOptions

  constructor(defaultOptions: TranscribeOptions = {}) {
    this.defaultOptions = defaultOptions
  }

  transcribe(file: File, runtimeOptions: TranscribeOptions = {}): MediaTranscribeStream {
    return new OpenAiCompatibleTranscribeStream(file, {
      ...this.defaultOptions,
      ...runtimeOptions,
    })
  }
}

/**
 * Local-Whisper model union doesn't apply here, so we expose an empty
 * `modelOptions` list. The Caption Maker UI populates a separate runtime
 * cache (`cachedModels`) via the provider's `/models` endpoint.
 */
export const openaiCompatibleTranscriptionAdapter: MediaTranscriptionAdapter = {
  id: OPENAI_COMPATIBLE_TRANSCRIPTION_ADAPTER_ID,
  label: 'Custom AI (OpenAI-compatible)',
  // Keep the closed Whisper union satisfied; this value is never read for
  // the custom path because the registry default stays `browser-whisper`.
  defaultModel: 'whisper-tiny',
  modelOptions: [] as readonly MediaTranscriptionModelOption[],
  getModelLabel(model) {
    return model as string
  },
  createTranscriber(options?: TranscribeOptions): MediaTranscriber {
    return new OpenAiCompatibleTranscriber(options)
  },
}

export interface CustomAiModelListEntry {
  id: string
  label?: string
}

/**
 * Fetch model list from the configured provider. Used by the Caption Maker
 * settings panel's "Load" button.
 */
export async function fetchCustomAiModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<CustomAiModelListEntry[]> {
  if (!baseUrl) throw new Error('Base URL is required')
  if (!apiKey) throw new Error('API key is required')

  const response = await fetch(`${trimTrailingSlash(baseUrl)}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Failed to load models (${response.status})${detail ? `: ${detail}` : ''}`)
  }

  const payload = (await response.json()) as { data?: Array<{ id?: unknown; name?: unknown }> }
  if (!Array.isArray(payload.data)) {
    throw new Error('Models response is missing a `data` array')
  }

  const entries: CustomAiModelListEntry[] = []
  for (const entry of payload.data) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) continue
    const name = (entry as { name?: unknown }).name
    entries.push({ id, ...(typeof name === 'string' ? { label: name } : {}) })
  }
  return entries
}

/**
 * Fetch voice list from the configured provider's `/audio/voices` endpoint
 * (kokoro-fastapi / Speaches / OpenedAI Speech convention). OpenAI itself
 * does NOT expose this endpoint — callers should treat a thrown error as
 * "voices not discoverable" and fall back to a free-text input.
 *
 * Tolerates several common response shapes:
 *   - `{ voices: ["v1", "v2"] }`
 *   - `{ voices: [{ id: "v1", name: "..." }] }`
 *   - `{ data: [{ id: "v1" }] }`
 *   - `["v1", "v2"]`
 */
export async function fetchCustomAiVoices(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<CustomAiModelListEntry[]> {
  if (!baseUrl) throw new Error('Base URL is required')
  if (!apiKey) throw new Error('API key is required')

  const response = await fetch(`${trimTrailingSlash(baseUrl)}/audio/voices`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Failed to load voices (${response.status})${detail ? `: ${detail}` : ''}`)
  }

  const payload = (await response.json()) as unknown
  return parseVoicesPayload(payload)
}

function parseVoicesPayload(payload: unknown): CustomAiModelListEntry[] {
  const candidates: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (((payload as { voices?: unknown }).voices ??
          (payload as { data?: unknown }).data ??
          []) as unknown[])
      : []

  if (!Array.isArray(candidates)) return []

  const entries: CustomAiModelListEntry[] = []
  const seen = new Set<string>()
  for (const entry of candidates) {
    if (typeof entry === 'string') {
      if (entry.length === 0 || seen.has(entry)) continue
      seen.add(entry)
      entries.push({ id: entry })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const labelRaw = (entry as { name?: unknown }).name ?? (entry as { label?: unknown }).label
    const label = typeof labelRaw === 'string' && labelRaw !== id ? labelRaw : undefined
    entries.push({ id, ...(label ? { label } : {}) })
  }
  return entries
}
