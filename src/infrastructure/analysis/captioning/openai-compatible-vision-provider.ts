/**
 * Custom AI vision captioning provider — calls an OpenAI-compatible
 * `POST /chat/completions` endpoint with a vision-capable model
 * (gpt-4o-mini, gemini-2.5-flash via OpenRouter, claude-3-5-haiku, etc.).
 *
 * Output shape matches `MediaCaption` so it slots into the same persistence
 * + scene-browser path as the local LFM captioner.
 */

import { createLogger } from '@/shared/logging/logger'
import { getOpenAiCompatibleVisionConfig } from './openai-compatible-vision-config'
import { captureFrame } from './capture-frame'
import type { MediaCaption, MediaCaptioningProvider, SceneCaptionData } from './types'

const log = createLogger('OpenAiCompatibleVisionProvider')

export const OPENAI_COMPATIBLE_VISION_PROVIDER_ID = 'openai-compatible-vision'

const DEFAULT_SAMPLE_INTERVAL_SEC = 3
/**
 * Number of concurrent /chat/completions requests during captioning.
 *
 * Frame capture itself is sequential (one HTMLVideoElement, one seek at a
 * time), but each captioned frame is an independent network call — the
 * latency-bound cost. 4 in flight gives a real ~4× speedup over sequential
 * without hitting most provider rate limits. Bump cautiously.
 */
const CAPTION_CONCURRENCY = 4

const SYSTEM_PROMPT = [
  'You describe a single video frame for an editor. Return ONLY a JSON object — no prose, no markdown fences.',
  'Schema:',
  '{',
  '  "text": "one short sentence describing what is visible",',
  '  "sceneData": {',
  '    "shotType": "wide | medium | close | extreme close | aerial | over-shoulder | ...",',
  '    "subjects": ["..."],',
  '    "action": "...",',
  '    "setting": "...",',
  '    "lighting": "...",',
  '    "timeOfDay": "...",',
  '    "weather": "..."',
  '  }',
  '}',
  'sceneData fields are optional — omit any you cannot determine. Keep "text" under 25 words.',
].join('\n')

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsDataURL(blob)
  })
}

interface VisionResponseShape {
  text?: string
  sceneData?: SceneCaptionData
}

/**
 * Forgiving JSON extractor — strips ```json fences and pulls the first
 * balanced `{…}` block when the model returns prose around the JSON.
 */
function parseVisionResponse(raw: string): VisionResponseShape {
  if (!raw) return {}
  const trimmed = raw.trim()

  // Try plain parse first.
  try {
    return JSON.parse(trimmed) as VisionResponseShape
  } catch {
    /* fall through */
  }

  // Strip code fences.
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (fenced !== trimmed) {
    try {
      return JSON.parse(fenced) as VisionResponseShape
    } catch {
      /* fall through */
    }
  }

  // Balanced-brace extractor.
  const start = fenced.indexOf('{')
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < fenced.length; i++) {
      const ch = fenced[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = fenced.slice(start, i + 1)
          try {
            return JSON.parse(candidate) as VisionResponseShape
          } catch {
            return {}
          }
        }
      }
    }
  }
  return {}
}

interface OpenAiChatChoice {
  message?: { content?: unknown }
}
interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[]
}

async function captionFrame(
  imageBlob: Blob,
  timeSec: number,
  signal: AbortSignal | undefined,
): Promise<Pick<MediaCaption, 'text' | 'sceneData'>> {
  const config = getOpenAiCompatibleVisionConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('Custom AI vision base URL is not configured.')
  if (!apiKey) throw new Error('Custom AI vision API key is not configured.')
  if (!model) throw new Error('Custom AI vision model is not selected.')

  const dataUrl = await blobToDataUrl(imageBlob)
  const url = `${trimTrailingSlash(baseUrl)}/chat/completions`

  // We deliberately do NOT send `response_format: { type: 'json_object' }` —
  // many OpenAI-compatible gateways (e.g. routers that proxy Gemini/Claude)
  // either reject the field with 400 or silently break the response. The
  // system prompt already demands JSON-only output, and the forgiving parser
  // (see `parseVisionResponse`) tolerates ```json fences or extra prose.
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Frame at ${timeSec.toFixed(2)}s — describe.` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      `Vision request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Vision API failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const payload = (await response.json()) as OpenAiChatResponse
  const raw = payload.choices?.[0]?.message?.content
  const content = typeof raw === 'string' ? raw : ''
  const parsed = parseVisionResponse(content)

  return {
    text: typeof parsed.text === 'string' ? parsed.text : '',
    sceneData: parsed.sceneData,
  }
}

export const openaiCompatibleVisionProvider: MediaCaptioningProvider = {
  id: OPENAI_COMPATIBLE_VISION_PROVIDER_ID,
  label: 'Custom AI (Vision)',

  async captionVideo(video, options = {}) {
    const {
      onProgress,
      signal,
      sampleIntervalSec: rawSampleInterval = DEFAULT_SAMPLE_INTERVAL_SEC,
      saveThumbnail,
    } = options
    const sampleIntervalSec =
      Number.isFinite(rawSampleInterval) && rawSampleInterval > 0
        ? rawSampleInterval
        : DEFAULT_SAMPLE_INTERVAL_SEC

    const duration = video.duration || 0
    if (duration <= 0) return []

    const timestamps: number[] = []
    for (let time = 0; time < duration; time += sampleIntervalSec) {
      timestamps.push(time)
    }
    if (
      timestamps.length > 0 &&
      timestamps[timestamps.length - 1]! + sampleIntervalSec * 0.5 < duration
    ) {
      timestamps.push(Math.max(0, duration - 0.1))
    }

    // Phase 1 — capture every frame sequentially (HTMLVideoElement only
    // has one playhead so seeks can't run in parallel). Capture is fast
    // (~50ms/frame); the network round-trip is the real cost and gets
    // parallelised in phase 2.
    const frames: Array<{ index: number; timeSec: number; blob: Blob }> = []
    for (let index = 0; index < timestamps.length; index += 1) {
      if (signal?.aborted) break
      const timeSec = timestamps[index]!
      const blob = await captureFrame(video, timeSec)
      frames.push({ index, timeSec, blob })
      onProgress?.({
        stage: 'captioning',
        percent: ((index + 1) / timestamps.length) * 5, // capture phase = 0–5%
        framesAnalyzed: 0,
        totalFrames: timestamps.length,
      })
    }

    if (frames.length === 0 || signal?.aborted) return []

    // Phase 2 — caption in parallel with bounded concurrency.
    const slots: Array<MediaCaption | null> = new Array(frames.length).fill(null)
    let completedCount = 0
    let attempted = 0
    let failed = 0
    let lastError: unknown = null
    let queueIndex = 0

    const runWorker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) return
        const localIndex = queueIndex
        queueIndex += 1
        if (localIndex >= frames.length) return
        const job = frames[localIndex]!

        attempted += 1
        let result: Pick<MediaCaption, 'text' | 'sceneData'>
        try {
          result = await captionFrame(job.blob, job.timeSec, signal)
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return
          failed += 1
          lastError = error
          log.warn('Frame caption failed — skipping', { index: job.index, error })
          completedCount += 1
          onProgress?.({
            stage: 'captioning',
            percent: 5 + (completedCount / frames.length) * 95,
            framesAnalyzed: completedCount,
            totalFrames: frames.length,
          })
          continue
        }

        if (result.text) {
          let thumbRelPath: string | undefined
          if (saveThumbnail) {
            try {
              thumbRelPath = await saveThumbnail(job.index, job.blob)
            } catch (error) {
              log.warn('Caption thumbnail persist failed — skipping', {
                index: job.index,
                error,
              })
            }
          }
          slots[job.index] = {
            timeSec: Math.round(job.timeSec * 10) / 10,
            text: result.text,
            ...(result.sceneData ? { sceneData: result.sceneData } : {}),
            ...(thumbRelPath ? { thumbRelPath } : {}),
          }
        }

        completedCount += 1
        onProgress?.({
          stage: 'captioning',
          percent: 5 + (completedCount / frames.length) * 95,
          framesAnalyzed: completedCount,
          totalFrames: frames.length,
        })
      }
    }

    const workerCount = Math.min(CAPTION_CONCURRENCY, frames.length)
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

    const captions = slots.filter((entry): entry is MediaCaption => entry !== null)

    // If every attempted frame failed, surface the last server error so the
    // user sees a concrete message ("Vision API failed (400): …") instead
    // of a silent "no captions generated" notification.
    if (captions.length === 0 && attempted > 0 && failed === attempted && lastError) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`Custom AI vision failed: ${String(lastError)}`)
    }

    return captions
  },

  async captionImage(imageBlob, options = {}) {
    const { onProgress, signal } = options
    if (signal?.aborted) return []

    onProgress?.({ stage: 'captioning', percent: 50, framesAnalyzed: 0, totalFrames: 1 })
    let result: Pick<MediaCaption, 'text' | 'sceneData'>
    try {
      result = await captionFrame(imageBlob, 0, signal)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return []
      log.warn('Image caption failed', error)
      return []
    }
    onProgress?.({ stage: 'captioning', percent: 100, framesAnalyzed: 1, totalFrames: 1 })

    return result.text
      ? [
          {
            timeSec: 0,
            text: result.text,
            ...(result.sceneData ? { sceneData: result.sceneData } : {}),
          },
        ]
      : []
  },
}

// Test seam — exposes the JSON parser for unit testing without spinning up fetch.
export const __test = { parseVisionResponse }
