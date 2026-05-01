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
 * Decode the source file and re-encode just the audio track using the
 * first browser-supported codec from {@link PREFERRED_OUTPUT_CODECS}.
 */
export async function extractAudioForUpload(
  source: Blob,
  fileName: string,
  options: ExtractAudioForUploadOptions = {},
): Promise<ExtractedAudio> {
  const channels = options.channels ?? 1
  const sampleRate = options.sampleRate ?? 16_000
  const bitrate = options.bitrate ?? 64_000

  const codec = await getFirstEncodableAudioCodec([...PREFERRED_OUTPUT_CODECS], {
    numberOfChannels: channels,
    sampleRate,
    bitrate,
  })
  if (!codec) {
    throw new Error('No browser-supported audio encoder is available for upload extraction')
  }
  const plan = buildCodecPlan(codec)

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  })
  try {
    const output = new Output({
      format: plan.format,
      target: new BufferTarget(),
    })

    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: {
        codec: plan.codec,
        bitrate,
        numberOfChannels: channels,
        sampleRate,
      },
    })

    if (!conversion.isValid) {
      // Filter out the deliberate video discard — surfacing it in the
      // error message would mislead users into thinking video discard
      // is the problem.
      const reasons = conversion.discardedTracks
        .filter((t) => t.reason !== 'discarded_by_user')
        .map((t) => t.reason)
        .join(', ')
      throw new Error(
        `Audio extraction is not possible for this file${reasons ? ` (${reasons})` : ''}`,
      )
    }

    if (options.onProgress) {
      conversion.onProgress = (progress) => options.onProgress?.(progress)
    }

    const onAbort = () => {
      void conversion.cancel()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await conversion.execute()
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }

    const buffer = output.target.buffer
    if (!buffer) {
      throw new Error('Audio extraction finished without producing data')
    }
    return {
      blob: new Blob([buffer], { type: plan.mimeType }),
      fileName: deriveFileName(fileName, plan.extension),
      mimeType: plan.mimeType,
    }
  } finally {
    // `Input` implements Disposable but TS targets without using-statements
    // need an explicit cleanup call. The class exposes no public `dispose`,
    // so Symbol.dispose is the documented hook.
    const disposable = input as unknown as { [Symbol.dispose]?: () => void }
    disposable[Symbol.dispose]?.()
  }
}
