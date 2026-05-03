/**
 * Frame extraction utilities for the Add Cover feature.
 *
 *   - {@link renderCoverFrame}                — render an arbitrary frame from
 *     a SubComposition to a JPEG Blob (full-res, encoded in the worker).
 *   - {@link generateFilmstripFrames}         — render N evenly-spaced frames
 *     and resolve once all are ready (legacy/back-compat shape).
 *   - {@link generateFilmstripFramesStreaming} — render N evenly-spaced frames
 *     and emit each as an `ImageBitmap` as soon as it's ready, so the
 *     filmstrip UI can populate progressively without waiting for the whole
 *     batch.
 *   - {@link persistCoverFrame}               — turn a Blob into a real
 *     Media Library item so the cover survives reload.
 *
 * Rendering itself runs inside `cover-render.worker.ts` — preload + GPU
 * pipeline + composition rendering all happen off the main thread, with
 * bitmaps transferred zero-copy.
 */

import type { MediaMetadata } from '@/types/storage'
import { createLogger } from '@/shared/logging/logger'
import { createManagedWorker } from '@/shared/utils/managed-worker'

import {
  buildSubCompositionInput,
  collectSubCompositionMediaIds,
  mediaLibraryService,
  resolveMediaUrl,
  resolveMediaUrls,
  useCompositionsStore,
  useMediaLibraryStore,
  type SubComposition,
} from './deps/timeline'
import type {
  CoverRenderFormat,
  CoverRenderRequest,
  CoverRenderWorkerRequest,
  CoverRenderWorkerResponse,
} from './workers/cover-render.worker'

const logger = createLogger('CompoundCover:FrameExtraction')

const FILMSTRIP_THUMB_WIDTH = 240
const FILMSTRIP_THUMB_HEIGHT = 135
const PREVIEW_THUMB_MAX = 720

interface RenderFrameOptions {
  width?: number
  height?: number
  quality?: number
}

const coverWorkerManager = createManagedWorker({
  createWorker: () =>
    new Worker(new URL('./workers/cover-render.worker.ts', import.meta.url), {
      type: 'module',
    }),
})

interface PendingRequest {
  onFrame: (response: Extract<CoverRenderWorkerResponse, { type: 'frame' }>) => void
  resolve: () => void
  reject: (error: Error) => void
}

const pendingRequests = new Map<string, PendingRequest>()
let workerListenersAttached = false

function ensureWorkerListeners(): Worker {
  const worker = coverWorkerManager.getWorker()
  if (workerListenersAttached) return worker

  worker.onmessage = (event: MessageEvent<CoverRenderWorkerResponse>) => {
    const data = event.data
    const pending = pendingRequests.get(data.requestId)
    if (!pending) {
      // Cancelled or superseded — close any in-flight bitmap so GPU memory
      // doesn't leak.
      if (data.type === 'frame' && data.bitmap) data.bitmap.close()
      return
    }
    if (data.type === 'frame') {
      pending.onFrame(data)
      return
    }
    if (data.type === 'complete') {
      pendingRequests.delete(data.requestId)
      pending.resolve()
      return
    }
    if (data.type === 'error') {
      pendingRequests.delete(data.requestId)
      pending.reject(new Error(data.error))
    }
  }

  worker.onerror = (event) => {
    const message = event.message || 'Cover render worker errored'
    for (const [, pending] of pendingRequests) {
      pending.reject(new Error(message))
    }
    pendingRequests.clear()
  }

  workerListenersAttached = true
  return worker
}

let requestSequence = 0
function nextRequestId(): string {
  requestSequence += 1
  return `cover-${Date.now().toString(36)}-${requestSequence}`
}

interface PostRenderRequestArgs {
  composition: CoverRenderRequest['composition']
  frames: number[]
  thumbWidth: number
  thumbHeight: number
  encode: CoverRenderRequest['encode']
  format?: CoverRenderFormat
  quality?: number
  onFrame: (response: Extract<CoverRenderWorkerResponse, { type: 'frame' }>) => void
}

interface RenderRequestHandle {
  promise: Promise<void>
  cancel: () => void
}

function postRenderRequest(args: PostRenderRequestArgs): RenderRequestHandle {
  const worker = ensureWorkerListeners()
  const requestId = nextRequestId()

  let resolveFn: () => void = () => {}
  let rejectFn: (error: Error) => void = () => {}
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })

  const pending: PendingRequest = {
    onFrame: args.onFrame,
    resolve: resolveFn,
    reject: rejectFn,
  }
  pendingRequests.set(requestId, pending)

  const request: CoverRenderRequest = {
    type: 'render',
    requestId,
    composition: args.composition,
    frames: args.frames,
    thumbWidth: args.thumbWidth,
    thumbHeight: args.thumbHeight,
    encode: args.encode,
    format: args.format,
    quality: args.quality,
  }
  worker.postMessage(request)

  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    const cancelMessage: CoverRenderWorkerRequest = { type: 'cancel', requestId }
    worker.postMessage(cancelMessage)
    // Drop the pending entry so any in-flight frame messages (or the eventual
    // `complete`) are treated as stale and cleaned up by the worker listener.
    pendingRequests.delete(requestId)
    rejectFn(new DOMException('Cover render cancelled', 'AbortError'))
  }

  return { promise, cancel }
}

/**
 * Keep only `video` items in the composition — drop text, image, shape,
 * audio, adjustment, and any other overlays. The cover frame should reflect
 * the raw video content of the compound clip; everything else (subtitles,
 * decorative shapes, lower-thirds, color-correction adjustment layers)
 * would burn into the thumbnail and obscure the underlying footage.
 *
 * Also drops keyframes and transitions that referenced removed items so
 * the renderer doesn't evaluate animations for content that no longer
 * exists.
 */
function keepOnlyVideoItems(
  composition: ReturnType<typeof buildSubCompositionInput>,
): ReturnType<typeof buildSubCompositionInput> {
  const removedItemIds = new Set<string>()
  const filteredTracks = composition.tracks.map((track) => {
    const items = track.items ?? []
    const kept = items.filter((item) => {
      if (item.type === 'video') return true
      removedItemIds.add(item.id)
      return false
    })
    return { ...track, items: kept }
  })

  if (removedItemIds.size === 0) return composition

  const filteredTransitions = (composition.transitions ?? []).filter(
    (t) => !removedItemIds.has(t.leftClipId) && !removedItemIds.has(t.rightClipId),
  )
  const filteredKeyframes = (composition.keyframes ?? []).filter(
    (k) => !removedItemIds.has(k.itemId),
  )

  return {
    ...composition,
    tracks: filteredTracks,
    transitions: filteredTransitions,
    keyframes: filteredKeyframes,
  }
}

async function buildResolvedComposition(
  composition: SubComposition,
): Promise<ReturnType<typeof buildSubCompositionInput>> {
  const compositionById = useCompositionsStore.getState().compositionById
  const mediaIds = collectSubCompositionMediaIds(composition.id, compositionById)
  await Promise.all(mediaIds.map((mediaId) => resolveMediaUrl(mediaId)))

  const compositionInput = buildSubCompositionInput(composition)
  const videoOnly = keepOnlyVideoItems(compositionInput)
  const resolvedTracks = await resolveMediaUrls(videoOnly.tracks, { useProxy: false })
  return { ...videoOnly, tracks: resolvedTracks }
}

function aspectFitDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxLong: number,
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: maxLong, height: Math.round((maxLong * 9) / 16) }
  }
  const longSide = Math.max(sourceWidth, sourceHeight)
  if (longSide <= maxLong) {
    return { width: sourceWidth, height: sourceHeight }
  }
  const scale = maxLong / longSide
  return {
    width: Math.max(2, Math.round(sourceWidth * scale)),
    height: Math.max(2, Math.round(sourceHeight * scale)),
  }
}

/**
 * Render a single frame from a compound clip's internal timeline at the given
 * frame number (relative to the SubComposition). Returns a JPEG Blob suitable
 * for both preview and persistence.
 */
export async function renderCoverFrame(
  compositionId: string,
  frame: number,
  options: RenderFrameOptions = {},
): Promise<Blob> {
  const composition = useCompositionsStore.getState().getComposition(compositionId)
  if (!composition) {
    throw new Error(`Composition ${compositionId} not found`)
  }
  if (composition.items.length === 0) {
    throw new Error('Compound clip has no content to render a cover from.')
  }
  if (typeof OffscreenCanvas !== 'function') {
    throw new Error('OffscreenCanvas is not available in this browser.')
  }

  const compositionInput = await buildResolvedComposition(composition)
  const safeFrame = Math.max(0, Math.min(frame, Math.max(0, composition.durationInFrames - 1)))
  const dims = aspectFitDimensions(
    composition.width,
    composition.height,
    options.width ?? PREVIEW_THUMB_MAX,
  )

  let blob: Blob | null = null
  const handle = postRenderRequest({
    composition: compositionInput,
    frames: [safeFrame],
    thumbWidth: options.width ?? dims.width,
    thumbHeight: options.height ?? dims.height,
    encode: 'blob',
    format: 'image/jpeg',
    quality: options.quality ?? 0.9,
    onFrame: (response) => {
      if (response.blob) blob = response.blob
    },
  })
  await handle.promise
  if (!blob) {
    throw new Error('Cover render produced no output')
  }
  return blob
}

export interface FilmstripFrame {
  frame: number
  bitmap: ImageBitmap
}

export interface FilmstripStreamHandle {
  promise: Promise<void>
  cancel: () => void
}

interface FilmstripPlan {
  compositionInput: CoverRenderRequest['composition']
  frames: number[]
  thumbWidth: number
  thumbHeight: number
}

async function buildFilmstripPlan(
  compositionId: string,
  count: number,
): Promise<FilmstripPlan | null> {
  const composition = useCompositionsStore.getState().getComposition(compositionId)
  if (!composition) {
    throw new Error(`Composition ${compositionId} not found`)
  }

  const duration = composition.durationInFrames
  if (duration <= 0 || composition.items.length === 0) {
    return null
  }

  const safeCount = Math.max(1, Math.floor(count))
  const compositionInput = await buildResolvedComposition(composition)
  const frames: number[] = []
  for (let i = 0; i < safeCount; i++) {
    const ratio = safeCount === 1 ? 0 : i / (safeCount - 1)
    frames.push(Math.min(duration - 1, Math.max(0, Math.round(ratio * (duration - 1)))))
  }

  const dims = aspectFitDimensions(composition.width, composition.height, FILMSTRIP_THUMB_WIDTH)
  return {
    compositionInput,
    frames,
    thumbWidth: dims.width,
    thumbHeight: Math.min(dims.height, FILMSTRIP_THUMB_HEIGHT),
  }
}

/**
 * Stream `count` evenly-spaced filmstrip thumbnails. The `onFrame` callback
 * fires once per frame as soon as it's rendered. The returned handle's
 * `cancel()` aborts in-flight rendering and instructs the worker to stop.
 *
 * Bitmaps that the consumer accepts via `onFrame` become its responsibility
 * — call `bitmap.close()` when done. Bitmaps for any frames that arrive
 * after `cancel()` are closed automatically.
 */
export function generateFilmstripFramesStreaming(
  compositionId: string,
  count: number,
  onFrame: (frame: FilmstripFrame) => void,
): FilmstripStreamHandle {
  let cancelInner: (() => void) | null = null
  let cancelledBeforeStart = false

  const promise = (async () => {
    const plan = await buildFilmstripPlan(compositionId, count)
    if (!plan) return
    if (cancelledBeforeStart) return

    const handle = postRenderRequest({
      composition: plan.compositionInput,
      frames: plan.frames,
      thumbWidth: plan.thumbWidth,
      thumbHeight: plan.thumbHeight,
      encode: 'bitmap',
      onFrame: (response) => {
        if (response.bitmap) {
          onFrame({ frame: response.frame, bitmap: response.bitmap })
        }
      },
    })
    cancelInner = handle.cancel
    try {
      await handle.promise
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      throw error
    }
  })()

  return {
    promise,
    cancel: () => {
      if (cancelInner) {
        cancelInner()
      } else {
        cancelledBeforeStart = true
      }
    },
  }
}

/**
 * Back-compat wrapper that buffers all frames before resolving. Prefer
 * {@link generateFilmstripFramesStreaming} for UI use cases — it shows
 * thumbnails as they become available.
 */
export async function generateFilmstripFrames(
  compositionId: string,
  count: number,
): Promise<FilmstripFrame[]> {
  const collected: FilmstripFrame[] = []
  try {
    await generateFilmstripFramesStreaming(compositionId, count, (frame) => {
      collected.push(frame)
    }).promise
  } catch (error) {
    for (const frame of collected) frame.bitmap.close()
    if (error instanceof DOMException && error.name === 'AbortError') {
      return []
    }
    logger.warn('Filmstrip rendering failed', error)
    throw error
  }
  return collected
}

export function revokeFilmstripFrames(frames: readonly FilmstripFrame[]): void {
  for (const frame of frames) {
    try {
      frame.bitmap.close()
    } catch {
      // already closed — ignore
    }
  }
}

export interface PersistCoverFrameOptions {
  /**
   * Short label baked into the filename and added as a media-library tag so
   * the user can find these images later (e.g. `'frame'`, `'ai'`). Defaults
   * to `'frame'` for backwards compatibility.
   */
  source?: 'frame' | 'ai'
  /**
   * Extra tags merged on top of the default tags (`'compound-cover'` plus
   * the source-specific tag). Useful for callers that want to surface the
   * image in custom views.
   */
  extraTags?: readonly string[]
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

function resolveImageExtension(mimeType: string, fallback: string): string {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() ?? ''
  return MIME_TO_EXTENSION[normalized] ?? fallback
}

function resolveImageCodec(mimeType: string, fallback: string): string {
  const subtype = mimeType.toLowerCase().split('/')[1]?.split(';')[0]?.trim()
  return subtype && subtype.length > 0 ? subtype : fallback
}

/**
 * Persist a chosen cover frame Blob as a Media Library item so it survives
 * reload and can be referenced by an ImageItem on the timeline.
 *
 * The codec / file extension is derived from `blob.type` so AI-generated
 * PNG / WebP images are stored with their original format instead of being
 * mislabelled as JPEG.
 */
export async function persistCoverFrame(
  compositionId: string,
  blob: Blob,
  width: number,
  height: number,
  options: PersistCoverFrameOptions = {},
): Promise<MediaMetadata> {
  const projectId = useMediaLibraryStore.getState().currentProjectId
  if (!projectId) {
    throw new Error('No active project — cannot save cover frame.')
  }

  const source = options.source ?? 'frame'
  // AI images come back as PNG by default; captured frames are JPEG. Falling
  // back to the source's typical format keeps things sensible if `blob.type`
  // is empty (some browsers / providers omit it).
  const fallbackMime = source === 'ai' ? 'image/png' : 'image/jpeg'
  const mimeType = blob.type || fallbackMime
  const extension = resolveImageExtension(mimeType, source === 'ai' ? 'png' : 'jpg')
  const codec = resolveImageCodec(mimeType, source === 'ai' ? 'png' : 'jpeg')

  const fileName = `cover-${source}-${compositionId.slice(0, 8)}-${Date.now()}.${extension}`
  const file = new File([blob], fileName, { type: mimeType })

  const tags = ['compound-cover', `compound-cover:${source}`]
  if (source === 'ai') tags.push('ai-generated')
  if (options.extraTags) {
    for (const tag of options.extraTags) {
      if (tag && !tags.includes(tag)) tags.push(tag)
    }
  }

  return mediaLibraryService.importGeneratedImage(file, projectId, {
    width,
    height,
    tags,
    codec,
  })
}
