/**
 * Cover Render Worker
 *
 * Renders one or more frames of a compound clip's internal timeline off the
 * main thread. Reuses ONE composition renderer per request — `preload()` and
 * GPU pipeline initialization happen once, then frames are rendered
 * sequentially. Each finished frame is streamed back to the main thread as
 * a transferable `ImageBitmap` (display path) and/or as an encoded `Blob`
 * (persistence path).
 *
 * This exists because the previous implementation fired N parallel
 * `renderSingleFrame()` calls on the main thread for the filmstrip — for
 * long compound clips this saturated the event loop and caused
 * "Page Unresponsive". WebGPU itself was already in use; the freeze came
 * from main-thread orchestration + N-fold media preload.
 */

// IMPORTANT: this shim must be the first import. The render engine pulls in
// modules that reference `window` at module load time; ES modules evaluate
// dependencies depth-first in declaration order, so importing the shim first
// guarantees `globalThis.window` exists before any of those modules runs.
import './worker-window-shim'

import { createCompositionRenderer } from '../deps/export-render'
import type { CompositionInputProps } from '../deps/export-render'
import { createLogger } from '@/shared/logging/logger'

const log = createLogger('CoverRenderWorker')

export type CoverRenderEncode = 'bitmap' | 'blob'
export type CoverRenderFormat = 'image/jpeg' | 'image/png' | 'image/webp'

export interface CoverRenderRequest {
  type: 'render'
  requestId: string
  composition: CompositionInputProps
  /** Frame numbers to render, in the order they should be processed. */
  frames: number[]
  /** Output thumbnail width in pixels. */
  thumbWidth: number
  /** Output thumbnail height in pixels. */
  thumbHeight: number
  /** 'bitmap' streams ImageBitmap (zero-copy display); 'blob' encodes JPEG. */
  encode: CoverRenderEncode
  /** Image format for `encode: 'blob'`. Defaults to 'image/jpeg'. */
  format?: CoverRenderFormat
  /** Encoder quality 0..1 for `encode: 'blob'`. Defaults to 0.85. */
  quality?: number
}

export interface CoverRenderCancelRequest {
  type: 'cancel'
  requestId: string
}

export type CoverRenderWorkerRequest = CoverRenderRequest | CoverRenderCancelRequest

export interface CoverRenderFrameResponse {
  type: 'frame'
  requestId: string
  frame: number
  bitmap?: ImageBitmap
  blob?: Blob
  width: number
  height: number
}

export interface CoverRenderCompleteResponse {
  type: 'complete'
  requestId: string
}

export interface CoverRenderErrorResponse {
  type: 'error'
  requestId: string
  error: string
}

export type CoverRenderWorkerResponse =
  | CoverRenderFrameResponse
  | CoverRenderCompleteResponse
  | CoverRenderErrorResponse

interface RequestState {
  aborted: boolean
}

const activeRequests = new Map<string, RequestState>()

function progressiveDownscale(
  source: OffscreenCanvas,
  targetWidth: number,
  targetHeight: number,
): OffscreenCanvas {
  let srcCanvas = source
  let srcW = source.width
  let srcH = source.height

  while (srcW > targetWidth * 2 || srcH > targetHeight * 2) {
    const nextW = Math.max(Math.ceil(srcW / 2), targetWidth)
    const nextH = Math.max(Math.ceil(srcH / 2), targetHeight)
    const step = new OffscreenCanvas(nextW, nextH)
    const stepCtx = step.getContext('2d')
    if (!stepCtx) {
      throw new Error('Failed to get 2d context for downscale step')
    }
    stepCtx.imageSmoothingQuality = 'high'
    stepCtx.drawImage(srcCanvas, 0, 0, nextW, nextH)
    srcCanvas = step
    srcW = nextW
    srcH = nextH
  }

  if (srcW === targetWidth && srcH === targetHeight) {
    return srcCanvas
  }

  const finalCanvas = new OffscreenCanvas(targetWidth, targetHeight)
  const finalCtx = finalCanvas.getContext('2d')
  if (!finalCtx) {
    throw new Error('Failed to get 2d context for final downscale')
  }
  finalCtx.imageSmoothingQuality = 'high'
  finalCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight)
  return finalCanvas
}

async function handleRender(request: CoverRenderRequest, state: RequestState): Promise<void> {
  const {
    requestId,
    composition,
    frames,
    thumbWidth,
    thumbHeight,
    encode,
    format = 'image/jpeg',
    quality = 0.85,
  } = request

  const compositionWidth = composition.width || 1920
  const compositionHeight = composition.height || 1080

  const renderCanvas = new OffscreenCanvas(compositionWidth, compositionHeight)
  const renderCtx = renderCanvas.getContext('2d')
  if (!renderCtx) {
    throw new Error('Failed to get 2d context for render canvas')
  }

  const renderer = await createCompositionRenderer(composition, renderCanvas, renderCtx)

  try {
    if (state.aborted) return
    await renderer.preload()

    for (const frame of frames) {
      if (state.aborted) return

      await renderer.renderFrame(frame)
      if (state.aborted) return

      const downscaled = progressiveDownscale(renderCanvas, thumbWidth, thumbHeight)

      if (encode === 'blob') {
        const blob = await downscaled.convertToBlob({ type: format, quality })
        if (state.aborted) return
        const response: CoverRenderFrameResponse = {
          type: 'frame',
          requestId,
          frame,
          blob,
          width: thumbWidth,
          height: thumbHeight,
        }
        self.postMessage(response)
      } else {
        const bitmap = await createImageBitmap(downscaled)
        if (state.aborted) {
          bitmap.close()
          return
        }
        const response: CoverRenderFrameResponse = {
          type: 'frame',
          requestId,
          frame,
          bitmap,
          width: thumbWidth,
          height: thumbHeight,
        }
        self.postMessage(response, { transfer: [bitmap] })
      }
    }
  } finally {
    try {
      renderer.dispose()
    } catch (error) {
      log.warn('Failed to dispose cover renderer', { error })
    }
  }
}

self.onmessage = async (event: MessageEvent<CoverRenderWorkerRequest>) => {
  const message = event.data

  if (message.type === 'cancel') {
    const state = activeRequests.get(message.requestId)
    if (state) {
      state.aborted = true
    }
    return
  }

  if (message.type !== 'render') return

  const { requestId } = message
  const state: RequestState = { aborted: false }
  activeRequests.set(requestId, state)

  try {
    await handleRender(message, state)
    const complete: CoverRenderCompleteResponse = { type: 'complete', requestId }
    self.postMessage(complete)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    log.error('Cover render worker failed', { requestId, error: messageText })
    const failure: CoverRenderErrorResponse = {
      type: 'error',
      requestId,
      error: messageText,
    }
    self.postMessage(failure)
  } finally {
    activeRequests.delete(requestId)
  }
}

export {}
