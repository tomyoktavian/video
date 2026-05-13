const TTS_ENGINE_STORAGE_KEY = 'editor:ttsEngine'
export type StoredTtsEngine = 'kokoro' | 'moss' | 'supertonic' | 'custom'

const DEFAULT_TTS_ENGINE: StoredTtsEngine = 'supertonic'

function isStoredTtsEngine(value: string): value is StoredTtsEngine {
  return value === 'kokoro' || value === 'moss' || value === 'supertonic' || value === 'custom'
}

/**
 * Read the user's saved TTS engine choice. When no value is stored (first
 * run, after a clear, etc.) the optional `fallback` argument decides — pass
 * `'custom'` when the Custom AI Text-to-Speech module is configured to make
 * Custom AI the default for fresh installs.
 */
export function getStoredTtsEngine(
  fallback: StoredTtsEngine = DEFAULT_TTS_ENGINE,
): StoredTtsEngine {
  try {
    const value = localStorage.getItem(TTS_ENGINE_STORAGE_KEY)
    return value && isStoredTtsEngine(value) ? value : fallback
  } catch {
    return fallback
  }
}

export function setStoredTtsEngine(engine: StoredTtsEngine): void {
  try {
    localStorage.setItem(TTS_ENGINE_STORAGE_KEY, engine)
  } catch {
    // ignore persistence failures
  }
}
