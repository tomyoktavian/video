/**
 * Custom AI image-generation adapter — sends a single
 * `POST /images/generations` to the OpenAI-compatible endpoint configured in
 * the Image Generator custom-ai slice. The same shape works for OpenAI
 * (`gpt-image-1`, `dall-e-3`), xAI Grok, and Google Gemini's OpenAI
 * compatibility layer
 * (`https://generativelanguage.googleapis.com/v1beta/openai/`). Users
 * configure the `baseUrl` per provider; this adapter does not branch on
 * provider.
 */

import { createLogger } from '@/shared/logging/logger'

import { getCustomAiImageGeneratorConfig } from './deps/settings'
import type { CoverImageRequest, CoverImageResponse } from './types'

const logger = createLogger('ImageGeneratorAdapter')

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Map the compound's `(width, height)` to a `size` string the configured
 * model will actually accept. The supported sizes differ per model:
 *
 *   - `gpt-image-1`: `1024x1024 | 1024x1536 | 1536x1024 | auto`
 *   - `dall-e-3`:    `1024x1024 | 1024x1792 | 1792x1024`
 *   - `dall-e-2`:    `256x256 | 512x512 | 1024x1024`
 *   - Gemini "nano-banana" / Imagen 3 (compat layer): tolerates the
 *     standard sizes; honours `aspect_ratio` more reliably than `size`.
 *
 * We pick the closest landscape / portrait variant that the named model
 * accepts. Falls back to `1024x1024` when in doubt.
 */
function resolveSize(width: number, height: number, model: string): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1024x1024'
  }
  const ratio = width / height
  const isSquareIsh = Math.abs(ratio - 1) < 0.05
  const lower = model.toLowerCase()

  // gpt-image-1 only accepts 1024x1024 / 1024x1536 / 1536x1024 / auto.
  if (lower.includes('gpt-image')) {
    if (isSquareIsh) return '1024x1024'
    return ratio > 1 ? '1536x1024' : '1024x1536'
  }
  // dall-e-2 only accepts square sizes — fall back to the largest one.
  if (lower.includes('dall-e-2')) {
    return '1024x1024'
  }
  // dall-e-3 and most generic OpenAI-compat providers (xAI Grok, Gemini
  // compat) accept the historical 1792x1024 / 1024x1792 pair.
  if (isSquareIsh) return '1024x1024'
  return ratio > 1 ? '1792x1024' : '1024x1792'
}

function gcd(a: number, b: number): number {
  let x = Math.max(1, Math.round(a))
  let y = Math.max(1, Math.round(b))
  while (y !== 0) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

function resolveAspectLabel(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1:1'
  }
  const w = Math.round(width)
  const h = Math.round(height)
  const d = gcd(w, h)
  return `${w / d}:${h / d}`
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

interface ImagesApiDataEntry {
  b64_json?: unknown
  url?: unknown
  mime_type?: unknown
}
interface ImagesApiResponse {
  data?: ImagesApiDataEntry[]
}

async function decodeFirstEntry(
  entry: ImagesApiDataEntry,
  signal?: AbortSignal,
): Promise<{ blob: Blob; mimeType: string }> {
  const mimeFromPayload = typeof entry.mime_type === 'string' ? entry.mime_type : ''
  if (typeof entry.b64_json === 'string' && entry.b64_json.length > 0) {
    const mime = mimeFromPayload || 'image/png'
    return { blob: base64ToBlob(entry.b64_json, mime), mimeType: mime }
  }
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    const fetchInit: RequestInit = signal ? { signal } : {}
    const res = await fetch(entry.url, fetchInit)
    if (!res.ok) {
      throw new Error(`Failed to fetch generated image (${res.status})`)
    }
    const blob = await res.blob()
    const mime = blob.type || mimeFromPayload || 'image/png'
    return { blob: blob.type ? blob : new Blob([blob], { type: mime }), mimeType: mime }
  }
  throw new Error('Image API response did not include `b64_json` or `url`.')
}

/**
 * Match the parameter name out of provider error messages like:
 *   "Unknown parameter: 'aspect_ratio'."
 *   "unknown parameter aspect_ratio"
 *   "litellm.BadRequestError: OpenAIException - Unknown parameter: 'aspect_ratio'.."
 * Returns null when no recognisable name is found.
 */
function detectUnknownParam(text: string): string | null {
  const match = text.match(/[Uu]nknown parameter:?\s*['"`]?([A-Za-z_][\w-]*)['"`]?/)
  return match?.[1] ?? null
}

/**
 * Apply known model-specific quirks before the first request, so we don't
 * waste a round-trip on parameters we know the provider rejects. Other
 * providers fall through to the generic retry-on-400 path.
 */
function preTrimBodyForModel(body: Record<string, unknown>, model: string): void {
  const lower = model.toLowerCase()
  // OpenAI's `gpt-image-1` (and the LiteLLM proxies in front of it) reject
  // `aspect_ratio`; only `size` is recognised. `dall-e-3` is similarly
  // strict.
  if (lower.includes('gpt-image') || lower.includes('dall-e')) {
    delete body.aspect_ratio
  }
}

const MAX_PARAM_RETRY_ATTEMPTS = 4

interface PostImageRequestOptions {
  url: string
  apiKey: string
  body: Record<string, unknown>
  signal?: AbortSignal
}

/**
 * POST to `/images/generations` with automatic parameter pruning. When the
 * provider replies with a 400 like "Unknown parameter: 'aspect_ratio'", the
 * offending field is stripped from the body and the request is retried.
 * This makes the adapter usable across providers with different param sets
 * (OpenAI strict, Gemini compat, xAI, LiteLLM proxies) without per-provider
 * branching here.
 */
async function postImageRequestWithFallback({
  url,
  apiKey,
  body,
  signal,
}: PostImageRequestOptions): Promise<Response> {
  let currentBody = body
  for (let attempt = 0; attempt <= MAX_PARAM_RETRY_ATTEMPTS; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(currentBody),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new Error(
        `Image generation request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response.ok) return response
    if (response.status !== 400 || attempt === MAX_PARAM_RETRY_ATTEMPTS) return response

    const detail = await response.text().catch(() => '')
    const offending = detectUnknownParam(detail)
    if (!offending || !(offending in currentBody)) {
      // Re-build a synthetic Response so the caller can read the original
      // error body (we already consumed it via `.text()` above).
      return new Response(detail, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    logger.info('Provider rejected an unknown parameter — retrying without it', {
      offending,
      attempt: attempt + 1,
      remainingKeys: Object.keys(currentBody).filter((k) => k !== offending),
    })
    const next = { ...currentBody }
    delete next[offending]
    currentBody = next
  }
  // Unreachable — the loop always returns or throws.
  throw new Error('Image generation failed: exhausted retries.')
}

async function readBlobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  // ImageBitmap is the cheapest cross-environment decoder available in the
  // browsers we target (Chromium-based) and avoids attaching DOM elements.
  try {
    const bitmap = await createImageBitmap(blob)
    const width = bitmap.width
    const height = bitmap.height
    bitmap.close?.()
    return { width, height }
  } catch (error) {
    logger.warn('createImageBitmap failed; falling back to 0x0 dimensions', error)
    return { width: 0, height: 0 }
  }
}

export async function generateCoverImage(request: CoverImageRequest): Promise<CoverImageResponse> {
  const config = getCustomAiImageGeneratorConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('Image Generator base URL is not configured.')
  if (!apiKey) throw new Error('Image Generator API key is not configured.')
  if (!model) throw new Error('Image Generator model is not selected.')
  if (request.prompt.trim().length === 0) {
    throw new Error('Type or generate a poster prompt before rendering an image.')
  }

  const size = resolveSize(request.width, request.height, model)
  const aspectLabel = resolveAspectLabel(request.width, request.height)
  const url = `${trimTrailingSlash(baseUrl)}/images/generations`

  // Build the union of every parameter we *might* send. Strict providers
  // (gpt-image-1, dall-e-3) get a pre-trimmed copy via `preTrimBodyForModel`;
  // the generic retry-on-"Unknown parameter" path inside
  // `postImageRequestWithFallback` covers everything else.
  const initialBody: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    n: 1,
    size,
    // Honoured by Gemini compat layer and a few other gateways; strict
    // providers reject it and the retry path strips it automatically.
    aspect_ratio: aspectLabel,
    response_format: 'b64_json',
    // Honoured by gpt-image-1 (low | medium | high). Skip when "auto" so
    // providers that reject unknown enum values stay happy.
    ...(request.quality && request.quality !== 'auto' ? { quality: request.quality } : {}),
  }
  preTrimBodyForModel(initialBody, model)

  const response = await postImageRequestWithFallback({
    url,
    apiKey,
    body: initialBody,
    ...(request.signal ? { signal: request.signal } : {}),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Image generation failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const payload = (await response.json()) as ImagesApiResponse
  const entry = payload.data?.[0]
  if (!entry) {
    throw new Error('Image API response did not include any data entries.')
  }

  const { blob, mimeType } = await decodeFirstEntry(entry, request.signal)
  const { width, height } = await readBlobDimensions(blob)
  logger.info('Image generated', { size, aspectLabel, width, height, bytes: blob.size, mimeType })
  return {
    blob,
    width: width || request.width,
    height: height || request.height,
    mimeType,
  }
}

export const __test = {
  resolveSize,
  resolveAspectLabel,
  base64ToBlob,
  detectUnknownParam,
  preTrimBodyForModel,
}
