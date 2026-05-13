/**
 * Spoiler TTS engine adapter — single dispatch surface that fans out to the
 * 4 TTS services exposed by the editor (custom / kokoro / supertonic / moss).
 *
 * Keeps the batch runner + episode narration generator agnostic about which
 * engine the user picked. Pipeline-wide concerns (project-id, abort signal,
 * media library tags) live in the callers; this module owns engine-specific
 * argument shapes only.
 */

import {
  customTtsService,
  kokoroTtsService,
  KOKORO_TTS_BEST_MODEL,
  mossTtsService,
  supertonicTtsService,
  type KokoroTtsVoice,
  type MossTtsVoice,
  type SupertonicTtsLanguage,
  type SupertonicTtsVoice,
} from './deps/tts'

export type SpoilerTtsEngine = 'custom' | 'kokoro' | 'supertonic' | 'moss'

export type SpoilerTtsEngineConfig =
  | { engine: 'custom'; voice?: string }
  | { engine: 'kokoro'; voice: KokoroTtsVoice }
  | {
      engine: 'supertonic'
      voice: SupertonicTtsVoice
      language: SupertonicTtsLanguage
      quality: number
    }
  | { engine: 'moss'; voice: MossTtsVoice }

export interface RunSpoilerTtsOptions {
  text: string
  speed: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export interface SpoilerTtsResult {
  blob: Blob
  file: File
  duration: number
}

export function getSpoilerTtsEngineTags(config: SpoilerTtsEngineConfig): string[] {
  const base = ['ai-generated', `tts-engine:${config.engine}`]
  switch (config.engine) {
    case 'kokoro':
      return [
        ...base,
        'kokoro-tts',
        `kokoro-voice:${config.voice}`,
        `kokoro-quality:${KOKORO_TTS_BEST_MODEL}`,
      ]
    case 'supertonic':
      return [
        ...base,
        'supertonic-tts',
        `supertonic-voice:${config.voice}`,
        `supertonic-lang:${config.language}`,
        `supertonic-quality:${config.quality}`,
      ]
    case 'moss':
      return [...base, 'moss-tts', `moss-voice:${config.voice}`]
    case 'custom':
    default:
      return [...base, ...(config.voice ? [`custom-tts-voice:${config.voice}`] : [])]
  }
}

export function isSpoilerTtsEngineSupported(config: SpoilerTtsEngineConfig): boolean {
  switch (config.engine) {
    case 'kokoro':
      return kokoroTtsService.isSupported()
    case 'supertonic':
      return supertonicTtsService.isSupported()
    case 'moss':
      return mossTtsService.isSupported()
    case 'custom':
    default:
      return customTtsService.isSupported()
  }
}

export async function runSpoilerTts(
  config: SpoilerTtsEngineConfig,
  options: RunSpoilerTtsOptions,
): Promise<SpoilerTtsResult> {
  switch (config.engine) {
    case 'kokoro':
      return kokoroTtsService.generateSpeechFile({
        text: options.text,
        voice: config.voice,
        speed: options.speed,
        model: KOKORO_TTS_BEST_MODEL,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      })
    case 'supertonic':
      return supertonicTtsService.generateSpeechFile({
        text: options.text,
        voice: config.voice,
        language: config.language,
        speed: options.speed,
        quality: config.quality,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      })
    case 'moss':
      return mossTtsService.generateSpeechFile({
        text: options.text,
        voice: config.voice,
        speed: options.speed,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      })
    case 'custom':
    default:
      return customTtsService.generateSpeechFile({
        text: options.text,
        speed: options.speed,
        ...(config.voice ? { voice: config.voice } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
  }
}
