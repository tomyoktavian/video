/**
 * Frame extraction utilities for the Add Cover feature.
 *
 *   - {@link renderCoverFrame}    — render an arbitrary frame from a
 *     SubComposition to a JPEG Blob (uses the same pipeline as compound-clip
 *     thumbnail generation, which already handles media URL resolution).
 *   - {@link generateFilmstripFrames} — render N evenly-spaced frames in
 *     parallel for the dialog's filmstrip strip.
 *   - {@link persistCoverFrame}   — turn a Blob into a real Media Library
 *     item so the cover survives reload and shows up in the library panel.
 */

import type { MediaMetadata } from '@/types/storage'
import { createLogger } from '@/shared/logging/logger'

import {
  buildSubCompositionInput,
  collectSubCompositionMediaIds,
  mediaLibraryService,
  renderSingleFrame,
  resolveMediaUrl,
  resolveMediaUrls,
  useCompositionsStore,
  useMediaLibraryStore,
  type SubComposition,
} from './deps/timeline'

const logger = createLogger('CompoundCover:FrameExtraction')

const FILMSTRIP_THUMB_WIDTH = 240
const FILMSTRIP_THUMB_HEIGHT = 135
const PREVIEW_THUMB_MAX = 720

interface RenderFrameOptions {
  width?: number
  height?: number
  quality?: number
}

async function buildResolvedComposition(
  composition: SubComposition,
): Promise<ReturnType<typeof buildSubCompositionInput>> {
  const compositionById = useCompositionsStore.getState().compositionById
  const mediaIds = collectSubCompositionMediaIds(composition.id, compositionById)
  await Promise.all(mediaIds.map((mediaId) => resolveMediaUrl(mediaId)))

  const compositionInput = buildSubCompositionInput(composition)
  const resolvedTracks = await resolveMediaUrls(compositionInput.tracks, { useProxy: false })
  return { ...compositionInput, tracks: resolvedTracks }
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

  return renderSingleFrame({
    composition: compositionInput,
    frame: safeFrame,
    width: options.width ?? dims.width,
    height: options.height ?? dims.height,
    quality: options.quality ?? 0.9,
    format: 'image/jpeg',
  })
}

export interface FilmstripFrame {
  frame: number
  blobUrl: string
}

/**
 * Render `count` evenly-spaced thumbnails across a compound clip's duration.
 * Used to populate the filmstrip strip in the frame picker UI. Resolved URLs
 * are owned by the caller — call {@link revokeFilmstripFrames} when the
 * dialog closes to free memory.
 */
export async function generateFilmstripFrames(
  compositionId: string,
  count: number,
): Promise<FilmstripFrame[]> {
  const composition = useCompositionsStore.getState().getComposition(compositionId)
  if (!composition) {
    throw new Error(`Composition ${compositionId} not found`)
  }

  const duration = composition.durationInFrames
  if (duration <= 0 || composition.items.length === 0) {
    return []
  }

  const safeCount = Math.max(1, Math.floor(count))
  const compositionInput = await buildResolvedComposition(composition)
  const frames: number[] = []
  for (let i = 0; i < safeCount; i++) {
    const ratio = safeCount === 1 ? 0 : i / (safeCount - 1)
    frames.push(Math.min(duration - 1, Math.max(0, Math.round(ratio * (duration - 1)))))
  }

  const dims = aspectFitDimensions(composition.width, composition.height, FILMSTRIP_THUMB_WIDTH)

  const results = await Promise.allSettled(
    frames.map((frame) =>
      renderSingleFrame({
        composition: compositionInput,
        frame,
        width: dims.width,
        height: Math.min(dims.height, FILMSTRIP_THUMB_HEIGHT),
        quality: 0.7,
        format: 'image/jpeg',
      }),
    ),
  )

  const out: FilmstripFrame[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      out.push({ frame: frames[index]!, blobUrl: URL.createObjectURL(result.value) })
    } else {
      logger.warn(`Filmstrip frame ${frames[index]} failed`, result.reason)
    }
  })
  return out
}

export function revokeFilmstripFrames(frames: readonly FilmstripFrame[]): void {
  for (const frame of frames) {
    try {
      URL.revokeObjectURL(frame.blobUrl)
    } catch {
      // ignore — already revoked or invalid
    }
  }
}

/**
 * Persist a chosen cover frame Blob as a Media Library item so it survives
 * reload and can be referenced by an ImageItem on the timeline.
 */
export async function persistCoverFrame(
  compositionId: string,
  blob: Blob,
  width: number,
  height: number,
): Promise<MediaMetadata> {
  const projectId = useMediaLibraryStore.getState().currentProjectId
  if (!projectId) {
    throw new Error('No active project — cannot save cover frame.')
  }

  const fileName = `cover-${compositionId.slice(0, 8)}-${Date.now()}.jpg`
  const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' })

  return mediaLibraryService.importGeneratedImage(file, projectId, {
    width,
    height,
    tags: ['compound-cover'],
    codec: 'jpeg',
  })
}
