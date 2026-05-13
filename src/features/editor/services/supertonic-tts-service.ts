import { createLogger } from '@/shared/logging/logger'
import {
  LOCAL_INFERENCE_UNLOADED_MESSAGE,
  localInferenceRuntimeRegistry,
  useLocalInferenceStore,
} from '@/shared/state/local-inference'
import type { LocalInferenceBackend } from '@/shared/state/local-inference'

const logger = createLogger('SupertonicTtsService')

const HOST_SOURCE = 'freecut-supertonic-tts-worker'
const CLIENT_SOURCE = 'freecut-supertonic-tts-client'
const WORKER_PATH = '/supertonic-tts/supertonic_tts.worker.js'
const MODEL_KEY = 'v3'
const MODEL_LABEL = 'Supertonic 3'
const ESTIMATED_BYTES = 270_000_000

export const SUPERTONIC_TTS_VOICE_OPTIONS = [
  { value: 'M3', label: 'Robert (M)' },
  { value: 'M1', label: 'Alex (M)' },
  { value: 'M2', label: 'James (M)' },
  { value: 'M4', label: 'Sam (M)' },
  { value: 'M5', label: 'Daniel (M)' },
  { value: 'F1', label: 'Sarah (F)' },
  { value: 'F2', label: 'Lily (F)' },
  { value: 'F3', label: 'Jessica (F)' },
  { value: 'F4', label: 'Olivia (F)' },
  { value: 'F5', label: 'Emily (F)' },
] as const

export type SupertonicTtsVoice = (typeof SUPERTONIC_TTS_VOICE_OPTIONS)[number]['value']

export const SUPERTONIC_TTS_LANGUAGES = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'id', label: 'Indonesian' },
  { value: 'ar', label: 'Arabic' },
  { value: 'bg', label: 'Bulgarian' },
  { value: 'cs', label: 'Czech' },
  { value: 'da', label: 'Danish' },
  { value: 'de', label: 'German' },
  { value: 'el', label: 'Greek' },
  { value: 'es', label: 'Spanish' },
  { value: 'et', label: 'Estonian' },
  { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' },
  { value: 'hi', label: 'Hindi' },
  { value: 'hr', label: 'Croatian' },
  { value: 'hu', label: 'Hungarian' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'lt', label: 'Lithuanian' },
  { value: 'lv', label: 'Latvian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ro', label: 'Romanian' },
  { value: 'ru', label: 'Russian' },
  { value: 'sk', label: 'Slovak' },
  { value: 'sl', label: 'Slovenian' },
  { value: 'sv', label: 'Swedish' },
  { value: 'tr', label: 'Turkish' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'vi', label: 'Vietnamese' },
] as const

export type SupertonicTtsLanguage = (typeof SUPERTONIC_TTS_LANGUAGES)[number]['value']

export const SUPERTONIC_TTS_DEFAULT_VOICE: SupertonicTtsVoice = 'M3'
export const SUPERTONIC_TTS_DEFAULT_LANGUAGE: SupertonicTtsLanguage = 'auto'
export const SUPERTONIC_TTS_DEFAULT_QUALITY = 8
export const SUPERTONIC_TTS_QUALITY_MIN = 2
export const SUPERTONIC_TTS_QUALITY_MAX = 16

interface GenerateSpeechOptions {
  text: string
  voice: SupertonicTtsVoice
  language: SupertonicTtsLanguage
  speed: number
  quality: number
  onProgress?: (stage: string) => void
}

interface ReadyInfo {
  type: 'ready'
  backend?: LocalInferenceBackend
}

interface ProgressInfo {
  type: 'progress'
  requestId: string
  stage?: string
}

interface SynthesisResponseData {
  wavBuffer: ArrayBuffer
  sampleRate: number
  duration: number
  detectedLanguage?: string
}

interface ResponseInfo {
  type: 'response'
  requestId: string
  ok: boolean
  error?: string
  data?: SynthesisResponseData
}

interface PendingRequest {
  onProgress?: (stage: string) => void
  reject: (reason?: unknown) => void
  resolve: (value: SynthesisResponseData | undefined) => void
}

export function getSupertonicTtsVoiceOption(voice: SupertonicTtsVoice): {
  value: SupertonicTtsVoice
  label: string
} {
  return (
    SUPERTONIC_TTS_VOICE_OPTIONS.find((option) => option.value === voice) ?? {
      value: voice,
      label: voice,
    }
  )
}

export function getSupertonicTtsLanguageOption(language: SupertonicTtsLanguage): {
  value: SupertonicTtsLanguage
  label: string
} {
  return (
    SUPERTONIC_TTS_LANGUAGES.find((option) => option.value === language) ?? {
      value: language,
      label: language,
    }
  )
}

function makeSafeFileNameSegment(text: string): string {
  const collapsed = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return collapsed.slice(0, 32) || 'speech'
}

function createOutputFileName(text: string, voice: SupertonicTtsVoice): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `ai-tts-${makeSafeFileNameSegment(text)}-${voice}-supertonic-${timestamp}.wav`
}

class SupertonicTtsService {
  private readonly runtimeFeature = 'tts'
  private readonly runtimeFeatureLabel = 'Supertonic 3'
  private activeJobs = 0
  private generationChain: Promise<void> | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private worker: Worker | null = null
  private workerReadyPromise: Promise<void> | null = null
  private workerReadyResolver: (() => void) | null = null
  private workerBackend: LocalInferenceBackend = 'unknown'

  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof Worker !== 'undefined' &&
      typeof globalThis !== 'undefined' &&
      'caches' in globalThis
    )
  }

  private getRuntimeId(): string {
    return 'supertonic-tts:v3'
  }

  private upsertRuntime(
    state: 'loading' | 'running' | 'ready' | 'error',
    errorMessage?: string,
  ): void {
    const runtimeId = this.getRuntimeId()
    const existing = useLocalInferenceStore.getState().runtimesById[runtimeId]
    const now = Date.now()

    if (existing) {
      localInferenceRuntimeRegistry.updateRuntime(runtimeId, {
        feature: this.runtimeFeature,
        featureLabel: this.runtimeFeatureLabel,
        modelKey: MODEL_KEY,
        modelLabel: MODEL_LABEL,
        backend: this.workerBackend,
        state,
        estimatedBytes: ESTIMATED_BYTES,
        activeJobs: this.activeJobs,
        unloadable: true,
        errorMessage,
        lastUsedAt: now,
      })
      return
    }

    localInferenceRuntimeRegistry.registerRuntime(
      {
        id: runtimeId,
        feature: this.runtimeFeature,
        featureLabel: this.runtimeFeatureLabel,
        modelKey: MODEL_KEY,
        modelLabel: MODEL_LABEL,
        backend: this.workerBackend,
        state,
        estimatedBytes: ESTIMATED_BYTES,
        activeJobs: this.activeJobs,
        loadedAt: now,
        lastUsedAt: now,
        unloadable: true,
        errorMessage,
      },
      {
        unload: () => this.unload(),
      },
    )
  }

  private incrementJobs(): void {
    this.activeJobs += 1
    this.upsertRuntime('running')
  }

  private decrementJobs(): void {
    this.activeJobs = Math.max(0, this.activeJobs - 1)
    this.upsertRuntime('ready')
  }

  private readonly handleWorkerMessage = (
    event: MessageEvent<ReadyInfo | ProgressInfo | ResponseInfo>,
  ) => {
    const payload = event.data
    if (!payload || (payload as { source?: string }).source !== HOST_SOURCE) {
      return
    }

    if (payload.type === 'ready') {
      if (payload.backend === 'webgpu' || payload.backend === 'wasm') {
        this.workerBackend = payload.backend
      }
      this.workerReadyResolver?.()
      return
    }

    if ('requestId' in payload) {
      const request = this.pendingRequests.get(payload.requestId)
      if (!request) {
        return
      }

      if (payload.type === 'progress') {
        request.onProgress?.(payload.stage || 'Preparing Supertonic 3...')
        return
      }

      this.pendingRequests.delete(payload.requestId)

      if (payload.ok) {
        request.resolve(payload.data)
      } else {
        request.reject(new Error(payload.error || 'Supertonic TTS request failed.'))
      }
    }
  }

  private readonly handleWorkerError = () => {
    this.workerReadyPromise = null
  }

  private async ensureWorkerLoaded(onProgress?: (stage: string) => void): Promise<void> {
    if (this.workerReadyPromise) {
      return this.workerReadyPromise
    }

    if (!this.isSupported()) {
      throw new Error('Supertonic 3 needs a browser with Web Worker + Cache Storage support.')
    }

    onProgress?.('Starting Supertonic 3 worker...')
    this.upsertRuntime('loading')

    this.workerReadyPromise = new Promise<void>((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, { type: 'module' })
      this.worker = worker
      worker.addEventListener('message', this.handleWorkerMessage)
      worker.addEventListener('error', this.handleWorkerError)

      const timeoutId = window.setTimeout(() => {
        this.workerReadyResolver = null
        this.workerReadyPromise = null
        worker.terminate()
        this.worker = null
        reject(new Error('Timed out while starting the Supertonic 3 worker.'))
      }, 30_000)

      this.workerReadyResolver = () => {
        window.clearTimeout(timeoutId)
        this.workerReadyResolver = null
        resolve()
      }
    })

    return this.workerReadyPromise
  }

  private async requestWorker(
    action: 'warmup' | 'synthesize' | 'dispose',
    payload: Record<string, unknown>,
    onProgress?: (stage: string) => void,
  ): Promise<SynthesisResponseData | undefined> {
    await this.ensureWorkerLoaded(onProgress)

    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `supertonic-${Date.now()}-${Math.random().toString(36).slice(2)}`

    if (!this.worker) {
      throw new Error('Supertonic 3 worker is not available.')
    }

    return new Promise<SynthesisResponseData | undefined>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject, onProgress })

      this.worker?.postMessage({
        source: CLIENT_SOURCE,
        action,
        requestId,
        ...payload,
      })
    })
  }

  private async withGenerationLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.generationChain ?? Promise.resolve()
    let releaseCurrent = () => {}
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const queued = previous.then(() => current)
    this.generationChain = queued

    await previous

    try {
      return await task()
    } finally {
      releaseCurrent()
      if (this.generationChain === queued) {
        this.generationChain = null
      }
    }
  }

  async unload(): Promise<void> {
    this.workerReadyPromise = null
    this.workerReadyResolver = null
    this.activeJobs = 0
    for (const request of this.pendingRequests.values()) {
      request.reject(new Error(LOCAL_INFERENCE_UNLOADED_MESSAGE))
    }
    this.pendingRequests.clear()

    if (this.worker) {
      try {
        this.worker.postMessage({
          source: CLIENT_SOURCE,
          action: 'dispose',
          requestId: 'dispose',
        })
      } catch (error) {
        logger.warn('Failed to send dispose message to Supertonic worker', error)
      }
      this.worker.removeEventListener('message', this.handleWorkerMessage)
      this.worker.removeEventListener('error', this.handleWorkerError)
      this.worker.terminate()
      this.worker = null
    }

    localInferenceRuntimeRegistry.unregisterRuntime(this.getRuntimeId())
  }

  async generateSpeechFile({
    text,
    voice,
    language,
    speed,
    quality,
    onProgress,
  }: GenerateSpeechOptions): Promise<{ blob: Blob; file: File; duration: number }> {
    const trimmedText = text.trim()
    if (!trimmedText) {
      throw new Error('Enter some text to synthesize.')
    }

    if (!this.isSupported()) {
      throw new Error('This browser cannot run the local Supertonic 3 runtime.')
    }

    return this.withGenerationLock(async () => {
      await this.ensureWorkerLoaded(onProgress)
      this.incrementJobs()

      try {
        onProgress?.('Generating speech with Supertonic 3...')
        const response = await this.requestWorker(
          'synthesize',
          {
            text: trimmedText,
            voice,
            language,
            speed,
            quality,
          },
          onProgress,
        )

        if (!response || !response.wavBuffer) {
          throw new Error('Supertonic 3 did not return any audio.')
        }

        const blob = new Blob([response.wavBuffer], { type: 'audio/wav' })
        const file = new File([blob], createOutputFileName(trimmedText, voice), {
          type: 'audio/wav',
          lastModified: Date.now(),
        })

        return {
          blob,
          file,
          duration: response.duration,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('Failed to generate speech with Supertonic 3 runtime', error)
        this.upsertRuntime('error', message)
        throw error
      } finally {
        this.decrementJobs()
      }
    })
  }
}

export const supertonicTtsService = new SupertonicTtsService()
