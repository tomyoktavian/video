import type { MainThreadMessage, PCMChunk, QuantizationType, WhisperWorkerMessage } from '../types'
import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('TranscriptionWorker')

const TRANSFORMERS_CDN_URL = 'https://esm.sh/@huggingface/transformers@3.8.1?bundle'
const WASM_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/'

type ASRPipeline = (input: Float32Array, options: Record<string, unknown>) => Promise<unknown>

interface ProgressInfo {
  status?: string
  file?: string
  loaded?: number
  total?: number
}

interface TransformersModule {
  env: {
    useBrowserCache: boolean
    allowLocalModels: boolean
    backends: {
      onnx: {
        wasm: {
          wasmPaths?: string
        }
      }
    }
  }
  pipeline: (
    task: string,
    modelId: string,
    options: {
      device: 'webgpu' | 'wasm'
      dtype: Record<string, string> | string
      progress_callback?: (progress: ProgressInfo) => void
    },
  ) => Promise<ASRPipeline>
}

let asrPipeline: ASRPipeline | null = null
let currentModelId: string | null = null
let port: MessagePort | null = null
let language: string | undefined
let pipelineReady = false
let paused = false
const queue: PCMChunk[] = []
let processing = false
let reportedEstimatedBytes = 0

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason = event.reason
  const message =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === 'string'
        ? reason
        : 'Unknown worker error'
  postMain({ type: 'error', message })
  event.preventDefault()
})

self.addEventListener('error', (event: ErrorEvent) => {
  postMain({
    type: 'error',
    message: event.message || (event.error instanceof Error ? event.error.message : 'Worker error'),
  })
})

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as WhisperWorkerMessage

  if (message.type === 'port') {
    port = message.port
    port.onmessage = (portEvent: MessageEvent<PCMChunk>) => {
      enqueue(portEvent.data)
    }
    return
  }

  if (message.type === 'init') {
    language = message.language
    await initPipeline(message.modelId, message.quantization ?? 'hybrid')
    return
  }

  if (message.type === 'pause') {
    paused = true
    return
  }

  if (message.type === 'resume') {
    if (!paused) return
    paused = false
    if (pipelineReady && !processing && queue.length > 0) {
      void processNext()
    }
  }
}

function enqueue(chunk: PCMChunk): void {
  queue.push(chunk)
  port?.postMessage(queue.length)
  if (pipelineReady && !processing && !paused) {
    void processNext()
  }
}

async function initPipeline(modelId: string, quantization: QuantizationType): Promise<void> {
  postMain({ type: 'progress', event: { stage: 'loading', progress: 0 } })
  reportedEstimatedBytes = 0

  try {
    const { pipeline, env } = (await import(
      /* @vite-ignore */ TRANSFORMERS_CDN_URL
    )) as TransformersModule

    env.useBrowserCache = true
    env.allowLocalModels = false
    env.backends.onnx.wasm.wasmPaths = WASM_CDN_URL

    if (asrPipeline && currentModelId !== modelId) {
      const disposable = asrPipeline as ASRPipeline & { dispose?: () => Promise<void> | void }
      await disposable.dispose?.()
      asrPipeline = null
    }

    if (!asrPipeline || currentModelId !== modelId) {
      currentModelId = modelId
      const downloadCache = new Map<string, { loaded: number; total: number }>()
      const dtype =
        quantization === 'hybrid'
          ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
          : quantization

      const progressCallback = (progress: ProgressInfo) => {
        if (progress.status !== 'download' || !progress.file || !progress.total) {
          return
        }

        downloadCache.set(progress.file, {
          loaded: progress.loaded ?? 0,
          total: progress.total,
        })

        let totalLoaded = 0
        let totalExpected = 0
        for (const entry of downloadCache.values()) {
          totalLoaded += entry.loaded
          totalExpected += entry.total
        }

        if (totalExpected > 0) {
          if (totalExpected > reportedEstimatedBytes) {
            reportedEstimatedBytes = totalExpected
            postMain({ type: 'runtime', info: { estimatedBytes: totalExpected } })
          }

          postMain({
            type: 'progress',
            event: {
              stage: 'loading',
              progress: Math.min(totalLoaded / totalExpected, 0.99),
            },
          })
        }
      }

      const loadPipeline = async (device: 'webgpu' | 'wasm') =>
        pipeline('automatic-speech-recognition', modelId, {
          device,
          dtype,
          progress_callback: progressCallback,
        })

      try {
        asrPipeline = await loadPipeline('webgpu')
        postMain({ type: 'runtime', info: { backend: 'webgpu' } })
      } catch (error) {
        logger.warn(
          `[FreeCut transcription] WebGPU initialization failed: ${
            error instanceof Error ? error.message : String(error)
          }. Falling back to WASM.`,
        )
        asrPipeline = await loadPipeline('wasm')
        postMain({ type: 'runtime', info: { backend: 'wasm' } })
      }

      postMain({ type: 'progress', event: { stage: 'loading', progress: 0.99 } })
      try {
        await asrPipeline(new Float32Array(1_600), {
          sampling_rate: 16_000,
          language: 'en',
        })
      } catch {
        // Ignore pre-warm failures. Real inference may still succeed.
      }
    }

    pipelineReady = true
    postMain({ type: 'progress', event: { stage: 'loading', progress: 1 } })
    postMain({ type: 'ready' })

    if (queue.length > 0 && !processing) {
      void processNext()
    }
  } catch (error) {
    currentModelId = null
    asrPipeline = null
    pipelineReady = false
    postMain({
      type: 'error',
      message: `Failed to initialize Whisper model: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }
}

async function processNext(): Promise<void> {
  if (!pipelineReady || !asrPipeline || paused) {
    processing = false
    return
  }

  const chunk = queue.shift()
  if (!chunk) {
    processing = false
    return
  }

  processing = true
  port?.postMessage(queue.length)

  try {
    await transcribeChunk(chunk)
  } catch (error) {
    postMain({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
    processing = false
    return
  }

  processing = false
  if (queue.length > 0 && !paused) {
    void processNext()
  }
}

/**
 * Word-grouping thresholds for converting Transformers.js word-level
 * timestamps into segments. Tuned to mirror the Custom AI grouping in
 * `openai-compatible-adapter.ts` so downstream caption-builder behavior
 * is consistent across providers.
 */
const WORD_GROUP_GAP_SECONDS = 0.6
const MAX_WORDS_PER_SEGMENT = 12
const SENTENCE_END = /[.!?]\s*$/

interface PipelineChunk {
  text: string
  timestamp: [number | null, number | null]
}

interface RawSegment {
  text: string
  start: number
  end: number
  words?: Array<{ text: string; start: number; end: number }>
}

function groupWordChunksIntoSegments(
  chunks: readonly PipelineChunk[],
  chunkOffset: number,
): RawSegment[] {
  const segments: RawSegment[] = []
  let bucket: Array<{ text: string; start: number; end: number }> = []

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

  for (const chunk of chunks) {
    const start = (chunk.timestamp[0] ?? 0) + chunkOffset
    const end = (chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0) + chunkOffset
    const text = chunk.text
    if (text.trim().length === 0 || end < start) continue

    const previous = bucket.at(-1)
    if (previous) {
      const gap = start - previous.end
      if (
        gap > WORD_GROUP_GAP_SECONDS ||
        SENTENCE_END.test(previous.text) ||
        bucket.length >= MAX_WORDS_PER_SEGMENT
      ) {
        flush()
      }
    }
    bucket.push({ text, start, end })
  }
  flush()
  return segments
}

async function transcribeChunk(chunk: PCMChunk): Promise<void> {
  if (!asrPipeline) {
    return
  }

  if (chunk.samples.length === 0) {
    if (chunk.final) {
      postMain({ type: 'done' })
    }
    return
  }

  postMain({ type: 'progress', event: { stage: 'transcribing', progress: 0 } })

  const baseOptions = {
    sampling_rate: 16_000,
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(language ? { language } : {}),
  } as const

  let wordLevel = true
  let result: unknown
  try {
    result = await asrPipeline(chunk.samples, {
      ...baseOptions,
      return_timestamps: 'word',
    })
  } catch (error) {
    // Models without cross-attention metadata (or quantizations that drop
    // the alignment heads) reject `return_timestamps: 'word'`. Fall back to
    // segment-level timestamps so transcription still works — captions will
    // use the wider segment timing instead of tight word grouping.
    logger.warn(
      `[FreeCut transcription] word-level timestamps unavailable, falling back to segment timestamps: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    wordLevel = false
    result = await asrPipeline(chunk.samples, {
      ...baseOptions,
      return_timestamps: true,
    })
  }

  const output = result as { chunks?: PipelineChunk[] }
  const rawChunks = output.chunks ?? []

  if (wordLevel) {
    const grouped = groupWordChunksIntoSegments(rawChunks, chunk.timestamp)
    for (const segment of grouped) {
      postMain({
        type: 'segment',
        segment: {
          text: segment.text,
          start: segment.start,
          end: segment.end,
          ...(segment.words ? { words: segment.words } : {}),
        },
      })
    }
  } else {
    for (const segment of rawChunks) {
      postMain({
        type: 'segment',
        segment: {
          text: segment.text,
          start: (segment.timestamp[0] ?? 0) + chunk.timestamp,
          end: (segment.timestamp[1] ?? 0) + chunk.timestamp,
        },
      })
    }
  }

  postMain({ type: 'progress', event: { stage: 'transcribing', progress: 1 } })

  if (chunk.final) {
    postMain({ type: 'done' })
  }
}

function postMain(message: MainThreadMessage): void {
  ;(self as unknown as Worker).postMessage(message)
}
