/**
 * Cross-feature contract — TTS services used by the Spoiler Generator.
 *
 * Spoiler runs may pick any of the same engines exposed in the editor's AI
 * panel: the cloud Custom AI endpoint, browser-local Kokoro / Supertonic 3 /
 * MOSS Nano. The batch runner + episode narration generator route through the
 * `tts-engine-adapter` which dispatches into one of these services.
 */

export { customTtsService } from '@/features/editor/services/custom-tts-service'
export {
  KOKORO_TTS_BEST_MODEL,
  KOKORO_TTS_VOICE_OPTIONS,
  getKokoroTtsVoiceOption,
  kokoroTtsService,
  type KokoroTtsModel,
  type KokoroTtsVoice,
} from '@/features/editor/services/kokoro-tts-service'
export {
  MOSS_TTS_VOICE_OPTIONS,
  getMossTtsVoiceOption,
  mossTtsService,
  type MossTtsVoice,
} from '@/features/editor/services/moss-tts-service'
export {
  SUPERTONIC_TTS_DEFAULT_LANGUAGE,
  SUPERTONIC_TTS_DEFAULT_QUALITY,
  SUPERTONIC_TTS_DEFAULT_VOICE,
  SUPERTONIC_TTS_LANGUAGES,
  SUPERTONIC_TTS_QUALITY_MAX,
  SUPERTONIC_TTS_QUALITY_MIN,
  SUPERTONIC_TTS_VOICE_OPTIONS,
  getSupertonicTtsLanguageOption,
  getSupertonicTtsVoiceOption,
  supertonicTtsService,
  type SupertonicTtsLanguage,
  type SupertonicTtsVoice,
} from '@/features/editor/services/supertonic-tts-service'
