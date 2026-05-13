// Supertonic 3 TTS Web Worker
// Pipeline mirrors the public Supertonic 3 HF Space demo:
//   duration_predictor → text_encoder → vector_estimator (×N denoise steps) → vocoder

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort.webgpu.min.mjs'
import {
  UnicodeProcessor,
  chunkText,
  loadAsset,
  loadVoiceStyleTensors,
  writeWav16BitPcm,
  concatFloat32WithSilence,
} from './helpers.js'
import { detectLanguage } from './language-detect.js'

const HOST_SOURCE = 'freecut-supertonic-tts-worker'
const CLIENT_SOURCE = 'freecut-supertonic-tts-client'

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/'
ort.env.wasm.numThreads = 1

let backend = 'wasm'
let sessions = null
let ttsConfig = null
let unicodeProcessor = null
let unicodeIndexer = null
const voiceStyleCache = new Map()

function postToMain(payload, transfer) {
  self.postMessage({ source: HOST_SOURCE, ...payload }, transfer || [])
}

async function detectBackend() {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (adapter) return 'webgpu'
    } catch (error) {
      console.warn('Supertonic WebGPU adapter request failed', error)
    }
  }
  return 'wasm'
}

async function createSession(modelBuffer) {
  const executionProviders = backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']
  return ort.InferenceSession.create(modelBuffer, {
    executionProviders,
    graphOptimizationLevel: 'all',
  })
}

async function ensureSessions(requestId) {
  if (sessions) return sessions
  backend = await detectBackend()

  const reportProgress = (stage) => {
    postToMain({ type: 'progress', requestId, stage })
  }

  reportProgress('Loading Supertonic 3 config...')
  ttsConfig = await loadAsset('onnx/tts.json', { json: true })
  unicodeIndexer = await loadAsset('onnx/unicode_indexer.json', { json: true })
  unicodeProcessor = new UnicodeProcessor(unicodeIndexer)

  reportProgress('Downloading Supertonic 3 ONNX models...')
  const [dpBuffer, textEncBuffer, vectorEstBuffer, vocoderBuffer] = await Promise.all([
    loadAsset('onnx/duration_predictor.onnx', {}, (info) =>
      reportProgress(info.fromCache ? 'Loading duration model...' : 'Downloading duration model...'),
    ),
    loadAsset('onnx/text_encoder.onnx', {}, (info) =>
      reportProgress(info.fromCache ? 'Loading text encoder...' : 'Downloading text encoder...'),
    ),
    loadAsset('onnx/vector_estimator.onnx', {}, (info) =>
      reportProgress(
        info.fromCache ? 'Loading denoiser...' : 'Downloading denoiser (largest model)...',
      ),
    ),
    loadAsset('onnx/vocoder.onnx', {}, (info) =>
      reportProgress(info.fromCache ? 'Loading vocoder...' : 'Downloading vocoder...'),
    ),
  ])

  // ONNX Runtime Web does not allow concurrent WebGPU session creation —
  // compile each model sequentially so the GPU compiler isn't double-booked.
  reportProgress(`Compiling duration predictor (${backend.toUpperCase()})...`)
  const dp = await createSession(dpBuffer)
  reportProgress(`Compiling text encoder (${backend.toUpperCase()})...`)
  const textEnc = await createSession(textEncBuffer)
  reportProgress(`Compiling denoiser (${backend.toUpperCase()})...`)
  const vectorEst = await createSession(vectorEstBuffer)
  reportProgress(`Compiling vocoder (${backend.toUpperCase()})...`)
  const vocoder = await createSession(vocoderBuffer)

  sessions = { dp, textEnc, vectorEst, vocoder }
  return sessions
}

async function loadVoiceStyle(voice) {
  const cached = voiceStyleCache.get(voice)
  if (cached) return cached
  const voiceJson = await loadAsset(`voice_styles/${voice}.json`, { json: true })
  const tensors = loadVoiceStyleTensors(voiceJson)
  voiceStyleCache.set(voice, tensors)
  return tensors
}

function makeFloatTensor(data, shape) {
  return new ort.Tensor('float32', data, shape)
}

function makeInt64Tensor(data, shape) {
  return new ort.Tensor('int64', data, shape)
}

function getSampleRate() {
  const candidate = ttsConfig?.ae?.sample_rate ?? ttsConfig?.sample_rate ?? 44100
  return Number(candidate) || 44100
}

function getLatentDim() {
  return Number(
    ttsConfig?.ttl?.latent_dim ?? ttsConfig?.ae?.latent_dim ?? ttsConfig?.latent_dim ?? 24,
  )
}

function getChunkCompress() {
  return Number(
    ttsConfig?.ttl?.chunk_compress_factor ??
      ttsConfig?.ae?.encoder?.chunk_compress_factor ??
      ttsConfig?.chunk_compress_factor ??
      1,
  )
}

function getBaseChunkSize() {
  return Number(
    ttsConfig?.ae?.encoder?.base_chunk_size ??
      ttsConfig?.ttl?.base_chunk_size ??
      ttsConfig?.base_chunk_size ??
      512,
  )
}

function resolveStyleDims(voiceShape, dataLength) {
  // Voice style files ship dims explicitly. Fall back to [1, dataLength] if missing.
  if (Array.isArray(voiceShape) && voiceShape.length > 0) return voiceShape
  return [1, dataLength]
}

function speedToDurationFactor(speed) {
  const normalized = Number.isFinite(speed) && speed > 0 ? speed : 1
  return 1 / normalized
}

async function runChunk({ chunkText: text, language, voiceStyle, speed, quality }) {
  const { textIds, textMask, batch, maxLen } = unicodeProcessor.call([text], language)
  const textIdsTensor = makeInt64Tensor(textIds, [batch, maxLen])
  const textMaskTensor = makeFloatTensor(textMask, [batch, 1, maxLen])

  const ttlShape = resolveStyleDims(voiceStyle.styleTtlShape, voiceStyle.styleTtl.length)
  const dpShape = resolveStyleDims(voiceStyle.styleDpShape, voiceStyle.styleDp.length)
  const styleTtlTensor = makeFloatTensor(voiceStyle.styleTtl, ttlShape)
  const styleDpTensor = makeFloatTensor(voiceStyle.styleDp, dpShape)

  // 1) Duration prediction → seconds-per-batch-row
  const durResult = await sessions.dp.run({
    text_ids: textIdsTensor,
    style_dp: styleDpTensor,
    text_mask: textMaskTensor,
  })
  const durTensor = durResult.duration ?? Object.values(durResult)[0]
  if (!durTensor) {
    throw new Error('Supertonic duration_predictor returned unexpected output keys.')
  }

  const durationFactor = speedToDurationFactor(speed)
  const rawDurations = Array.from(durTensor.data, (value) => Number(value))
  // Duration tensor has shape [batch, 1, 1]. Pick the first scalar per batch row.
  const perBatchDuration = []
  const innerStride = Math.max(1, rawDurations.length / batch)
  for (let row = 0; row < batch; row += 1) {
    const seconds = Math.max(0, rawDurations[row * innerStride] ?? 0)
    perBatchDuration.push(seconds * durationFactor)
  }
  const maxDuration = Math.max(...perBatchDuration, 0.01)
  const sampleRate = getSampleRate()
  const latentDim = getLatentDim()
  const chunkCompressFactor = getChunkCompress()
  const baseChunkSize = getBaseChunkSize()
  const chunkSize = baseChunkSize * chunkCompressFactor
  const wavLenMax = maxDuration * sampleRate
  const latentLength = Math.max(1, Math.floor((wavLenMax + chunkSize - 1) / chunkSize))
  const latentChannels = latentDim * chunkCompressFactor

  // 2) Text encoding
  const textEncResult = await sessions.textEnc.run({
    text_ids: textIdsTensor,
    style_ttl: styleTtlTensor,
    text_mask: textMaskTensor,
  })
  const textEmb = textEncResult.text_emb ?? Object.values(textEncResult)[0]

  // 3) Iterative denoising with Gaussian noise initialisation
  const latentSize = batch * latentChannels * latentLength
  const latentBuffer = new Float32Array(latentSize)
  for (let index = 0; index < latentSize; index += 1) {
    latentBuffer[index] = randn()
  }
  const latentMask = new Float32Array(batch * 1 * latentLength)
  latentMask.fill(1)
  const latentShape = [batch, latentChannels, latentLength]
  const latentMaskTensor = makeFloatTensor(latentMask, [batch, 1, latentLength])
  const totalStepTensor = makeFloatTensor(Float32Array.from([quality]), [batch])

  for (let step = 0; step < quality; step += 1) {
    const noisyLatentTensor = makeFloatTensor(latentBuffer, latentShape)
    const currentStepTensor = makeFloatTensor(Float32Array.from([step]), [batch])
    const stepResult = await sessions.vectorEst.run({
      noisy_latent: noisyLatentTensor,
      text_emb: textEmb,
      style_ttl: styleTtlTensor,
      text_mask: textMaskTensor,
      latent_mask: latentMaskTensor,
      total_step: totalStepTensor,
      current_step: currentStepTensor,
    })
    const denoised = stepResult.denoised_latent ?? Object.values(stepResult)[0]
    latentBuffer.set(denoised.data)
  }

  // 4) Vocoder → raw waveform
  const vocoderResult = await sessions.vocoder.run({
    latent: makeFloatTensor(latentBuffer, latentShape),
  })
  const wavTensor = vocoderResult.wav_tts ?? Object.values(vocoderResult)[0]
  const wavData = new Float32Array(wavTensor.data)
  const wavLen = Math.floor(sampleRate * perBatchDuration[0])
  return wavLen > 0 ? wavData.slice(0, wavLen) : wavData
}

function randn() {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

async function handleSynthesize(message) {
  const {
    requestId,
    text,
    voice,
    language,
    speed,
    quality,
  } = message

  await ensureSessions(requestId)
  postToMain({ type: 'progress', requestId, stage: 'Loading voice style...' })
  const voiceStyle = await loadVoiceStyle(voice)

  const resolvedLanguage = language === 'auto' ? detectLanguage(text) : language
  const chunks = chunkText(text, resolvedLanguage)
  const sampleRate = getSampleRate()
  const audioChunks = []

  for (let index = 0; index < chunks.length; index += 1) {
    postToMain({
      type: 'progress',
      requestId,
      stage: `Synthesizing chunk ${index + 1}/${chunks.length} (${quality} denoise steps)...`,
    })
    const audio = await runChunk({
      chunkText: chunks[index],
      language: resolvedLanguage,
      voiceStyle,
      speed,
      quality,
    })
    audioChunks.push(audio)
  }

  const merged = concatFloat32WithSilence(audioChunks, sampleRate, 0.3)
  const wavBuffer = writeWav16BitPcm(merged, sampleRate)
  const duration = merged.length / sampleRate

  postToMain(
    {
      type: 'response',
      requestId,
      ok: true,
      data: { wavBuffer, sampleRate, duration, detectedLanguage: resolvedLanguage },
    },
    [wavBuffer],
  )
}

self.addEventListener('message', async (event) => {
  const payload = event.data
  if (!payload || payload.source !== CLIENT_SOURCE) return

  if (payload.action === 'dispose') {
    sessions = null
    voiceStyleCache.clear()
    unicodeProcessor = null
    return
  }

  if (payload.action === 'warmup') {
    try {
      await ensureSessions(payload.requestId)
      postToMain({ type: 'response', requestId: payload.requestId, ok: true })
    } catch (error) {
      postToMain({
        type: 'response',
        requestId: payload.requestId,
        ok: false,
        error: error?.message || String(error),
      })
    }
    return
  }

  if (payload.action === 'synthesize') {
    try {
      await handleSynthesize(payload)
    } catch (error) {
      postToMain({
        type: 'response',
        requestId: payload.requestId,
        ok: false,
        error: error?.message || String(error),
      })
    }
  }
})

;(async () => {
  backend = await detectBackend()
  postToMain({ type: 'ready', backend })
})()
