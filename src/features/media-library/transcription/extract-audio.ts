/**
 * Extract a compact audio-only blob from a media file for upload to remote
 * transcription APIs (which usually cap at ~25 MB).
 *
 * Uses Mediabunny's `Conversion` to discard video tracks and re-encode the
 * audio. We pick a codec the browser can actually encode via WebCodecs —
 * MP3 isn't shipped in any browser, so we try **Opus (Ogg)** first, then
 * **AAC (M4A)** as a fallback. Whisper-compatible APIs accept both.
 *
 * At 64 kbps mono, output is ~0.5 MB/min — 25 MB covers ~50 minutes,
 * well over the typical clip length.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  getFirstEncodableAudioCodec,
  Input,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  type AudioCodec,
  type OutputFormat,
} from 'mediabunny'

export interface ExtractAudioForUploadOptions {
  /** Onward progress 0-1. */
  onProgress?: (progress: number) => void
  /** Output bitrate in bps. Defaults to 64 kbps mono. */
  bitrate?: number
  /** Output channel count. Defaults to 1 (mono). */
  channels?: number
  /** Output sample rate in Hz. Defaults to 16000 (Whisper-native). */
  sampleRate?: number
  /**
   * Override the default codec preference order. Some transcription models
   * (e.g. OpenAI's `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`) do not
   * accept Opus/Ogg uploads — pass `['aac']` to force `.m4a` output.
   */
  preferredCodecs?: readonly AudioCodec[]
  signal?: AbortSignal
}

export interface ExtractedAudio {
  blob: Blob
  fileName: string
  mimeType: string
}

interface CodecPlan {
  codec: AudioCodec
  format: OutputFormat
  mimeType: string
  extension: string
}

/**
 * Browser-encodable codecs compatible with the OpenAI / Whisper API.
 * Order matters — Opus is the most reliably available via WebCodecs across
 * Chromium browsers and produces the smallest files at speech bitrates.
 */
const PREFERRED_OUTPUT_CODECS: readonly AudioCodec[] = ['opus', 'aac']

function buildCodecPlan(codec: AudioCodec): CodecPlan {
  switch (codec) {
    case 'opus':
      return {
        codec,
        format: new OggOutputFormat(),
        mimeType: 'audio/ogg',
        extension: 'ogg',
      }
    case 'aac':
      return {
        codec,
        format: new Mp4OutputFormat(),
        mimeType: 'audio/mp4',
        extension: 'm4a',
      }
    default:
      throw new Error(`Unsupported codec for upload extraction: ${codec}`)
  }
}

function deriveFileName(originalName: string, extension: string): string {
  const dot = originalName.lastIndexOf('.')
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName
  return `${stem || 'audio'}.${extension}`
}

/**
 * Negative-timestamp errors from Mediabunny look like:
 *   "Timestamps must be non-negative (got -0.0000625s)."
 * Concatenated/merged MP4 files often have sub-millisecond negative
 * timestamps at splice points. We detect this specific failure and retry
 * the conversion with `trim.start = 0.01` to skip the malformed prefix
 * (10 ms is inaudible and well past any plausible splice artifact).
 */
const NEGATIVE_TIMESTAMP_PATTERN = /Timestamps must be non-negative/i
const TIMESTAMP_RECOVERY_TRIM_START_SEC = 0.01

interface RunConversionParams {
  source: Blob
  plan: CodecPlan
  channels: number
  sampleRate: number
  bitrate: number
  trimStart?: number
  onProgress?: (progress: number) => void
  signal?: AbortSignal
}

async function runConversionOnce(params: RunConversionParams): Promise<ArrayBuffer> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(params.source),
  })
  try {
    const output = new Output({
      format: params.plan.format,
      target: new BufferTarget(),
    })

    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: {
        codec: params.plan.codec,
        bitrate: params.bitrate,
        numberOfChannels: params.channels,
        sampleRate: params.sampleRate,
      },
      ...(params.trimStart !== undefined ? { trim: { start: params.trimStart } } : {}),
    })

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .filter((t) => t.reason !== 'discarded_by_user')
        .map((t) => t.reason)
        .join(', ')
      throw new Error(
        `Audio extraction is not possible for this file${reasons ? ` (${reasons})` : ''}`,
      )
    }

    if (params.onProgress) {
      conversion.onProgress = (progress) => params.onProgress?.(progress)
    }

    const onAbort = () => {
      void conversion.cancel()
    }
    params.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await conversion.execute()
    } finally {
      params.signal?.removeEventListener('abort', onAbort)
    }

    const buffer = output.target.buffer
    if (!buffer) {
      throw new Error('Audio extraction finished without producing data')
    }
    return buffer
  } finally {
    const disposable = input as unknown as { [Symbol.dispose]?: () => void }
    disposable[Symbol.dispose]?.()
  }
}

/**
 * Decode the source file and re-encode just the audio track using the
 * first browser-supported codec from {@link PREFERRED_OUTPUT_CODECS}.
 *
 * Includes an automatic retry path for merged/concatenated MP4 files whose
 * splice points produce sub-millisecond negative timestamps that Mediabunny
 * refuses by default — see {@link NEGATIVE_TIMESTAMP_PATTERN}.
 */
export async function extractAudioForUpload(
  source: Blob,
  fileName: string,
  options: ExtractAudioForUploadOptions = {},
): Promise<ExtractedAudio> {
  const channels = options.channels ?? 1
  const sampleRate = options.sampleRate ?? 16_000
  const bitrate = options.bitrate ?? 64_000

  const codecCandidates = options.preferredCodecs ?? PREFERRED_OUTPUT_CODECS
  const codec = await getFirstEncodableAudioCodec([...codecCandidates], {
    numberOfChannels: channels,
    sampleRate,
    bitrate,
  })
  if (!codec) {
    throw new Error('No browser-supported audio encoder is available for upload extraction')
  }
  const plan = buildCodecPlan(codec)

  const baseParams: Omit<RunConversionParams, 'trimStart'> = {
    source,
    plan,
    channels,
    sampleRate,
    bitrate,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }

  let buffer: ArrayBuffer
  try {
    buffer = await runConversionOnce(baseParams)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (NEGATIVE_TIMESTAMP_PATTERN.test(message)) {
      // Retry with a tiny start trim that pushes the conversion past the
      // negative-timestamp splice prefix in concatenated MP4 files.
      buffer = await runConversionOnce({
        ...baseParams,
        trimStart: TIMESTAMP_RECOVERY_TRIM_START_SEC,
      })
    } else {
      throw error
    }
  }

  return {
    blob: new Blob([buffer], { type: plan.mimeType }),
    fileName: deriveFileName(fileName, plan.extension),
    mimeType: plan.mimeType,
  }
}
