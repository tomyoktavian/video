/**
 * Custom AI TTS — calls an OpenAI-compatible `POST /audio/speech` endpoint.
 *
 * Designed to slot into the same shape as kokoro/moss TTS services so
 * `ai-panel.tsx` can branch on engine without restructuring.
 */

import { getCustomAiTextToSpeechConfig } from '@/features/editor/deps/settings-contract'
import { createLogger } from '@/shared/logging/logger'
import { getAudioBlobDurationSeconds } from '@/shared/utils/audio-blob-duration'

const logger = createLogger('CustomTtsService')

const DEFAULT_VOICE = 'alloy'
const SPEED_MIN = 0.25
const SPEED_MAX = 4

interface GenerateSpeechOptions {
  text: string
  speed: number
  /**
   * Override the voice from the saved settings. Used by the settings
   * dialog to preview a voice before committing to it.
   */
  voice?: string
  onProgress?: (message: string | null) => void
  signal?: AbortSignal
}

interface GenerateSpeechResult {
  blob: Blob
  file: File
  duration: number
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value))
}

function pickExtension(mime: string): string {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('flac')) return 'flac'
  return 'mp3'
}

async function generateSpeechFile({
  text,
  speed,
  voice: voiceOverride,
  onProgress,
  signal,
}: GenerateSpeechOptions): Promise<GenerateSpeechResult> {
  const config = getCustomAiTextToSpeechConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()

  if (!baseUrl) throw new Error('Custom TTS base URL is not configured.')
  if (!apiKey) throw new Error('Custom TTS API key is not configured.')
  if (!model) throw new Error('Custom TTS model is not selected.')

  const voice = (voiceOverride?.trim() || config.voice.trim() || DEFAULT_VOICE).trim()
  const language = config.language.trim()
  const url = `${trimTrailingSlash(baseUrl)}/audio/speech`

  onProgress?.('Calling Custom AI TTS...')

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        speed: clampSpeed(speed),
        ...(language ? { language } : {}),
      }),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      `Custom TTS request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Custom TTS failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const rawBlob = await response.blob()
  const finalBlob = rawBlob.type.startsWith('audio/')
    ? rawBlob
    : new Blob([rawBlob], { type: 'audio/mpeg' })

  onProgress?.('Decoding audio...')
  let duration = 0
  try {
    duration = await getAudioBlobDurationSeconds(finalBlob)
  } catch (error) {
    logger.warn('Failed to decode custom TTS audio for duration', error)
  }

  const extension = pickExtension(finalBlob.type)
  const fileName = `custom-tts-${Date.now()}.${extension}`
  const file = new File([finalBlob], fileName, {
    type: finalBlob.type,
    lastModified: Date.now(),
  })

  onProgress?.(null)

  return { blob: finalBlob, file, duration }
}

export const customTtsService = {
  isSupported(): boolean {
    if (typeof window === 'undefined') return false
    if (typeof fetch !== 'function') return false
    return true
  },
  generateSpeechFile,
}
