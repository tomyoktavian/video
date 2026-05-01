import type { CompositionInputProps } from '@/types/export'
import type { TimelineItem } from '@/types/timeline'
import { convertTimelineToComposition } from '../deps/export-contract'
import type { SubComposition } from '../stores/compositions-store'

/**
 * Label set on the cover image by the compound-cover feature
 * (`build-cover-items.ts`). Kept as a literal here to avoid a cross-feature
 * import; if either side changes, `build-cover-items.test.ts` will flag it.
 */
const COMPOUND_COVER_IMAGE_LABEL = 'Cover Frame'

function sanitizeTimelineItemForSignature(item: TimelineItem) {
  const serializableItem = {
    ...item,
  } as Partial<TimelineItem> & {
    src?: string
    thumbnailUrl?: string
    waveformData?: number[]
  }
  delete serializableItem.src
  delete serializableItem.thumbnailUrl
  delete serializableItem.waveformData
  return serializableItem
}

function buildSignatureNode(
  compositionId: string,
  compositionById: Record<string, SubComposition | undefined>,
  path: ReadonlySet<string>,
): unknown {
  const composition = compositionById[compositionId]
  if (!composition) {
    return { id: compositionId, missing: true }
  }

  if (path.has(compositionId)) {
    return { id: compositionId, cycle: true }
  }

  const nextPath = new Set(path)
  nextPath.add(compositionId)

  return {
    id: composition.id,
    name: composition.name,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    durationInFrames: composition.durationInFrames,
    backgroundColor: composition.backgroundColor ?? null,
    tracks: composition.tracks,
    items: composition.items.map((item) => ({
      item: sanitizeTimelineItemForSignature(item),
      child:
        item.type === 'composition' && item.compositionId
          ? buildSignatureNode(item.compositionId, compositionById, nextPath)
          : null,
    })),
    transitions: composition.transitions,
    keyframes: composition.keyframes,
  }
}

export function buildSubCompositionInput(composition: SubComposition): CompositionInputProps {
  return convertTimelineToComposition(
    composition.tracks,
    composition.items,
    composition.transitions,
    composition.fps,
    composition.width,
    composition.height,
    null,
    null,
    composition.keyframes,
    composition.backgroundColor,
  )
}

export function collectSubCompositionMediaIds(
  compositionId: string,
  compositionById: Record<string, SubComposition | undefined>,
): string[] {
  const mediaIds = new Set<string>()
  const visited = new Set<string>()

  const visit = (currentCompositionId: string) => {
    if (visited.has(currentCompositionId)) {
      return
    }

    visited.add(currentCompositionId)

    const composition = compositionById[currentCompositionId]
    if (!composition) {
      return
    }

    for (const item of composition.items) {
      if (item.mediaId) {
        mediaIds.add(item.mediaId)
      }

      if (item.type === 'composition' && item.compositionId) {
        visit(item.compositionId)
      }
    }
  }

  visit(compositionId)
  return [...mediaIds]
}

export function buildSubCompositionPreviewSignature(
  compositionId: string,
  compositionById: Record<string, SubComposition | undefined>,
): string {
  return JSON.stringify(buildSignatureNode(compositionId, compositionById, new Set()))
}

/**
 * Find the cover image item within a sub-composition. A cover is created by
 * `insertCover` (compound-cover feature) — it places an image item with a
 * specific label at frame 0, optionally on a "Cover" track. The label is
 * the most reliable signal because the user can rename the track.
 */
function findCoverImageItem(composition: SubComposition): TimelineItem | null {
  for (const item of composition.items) {
    if (item.type === 'image' && item.from === 0 && item.label === COMPOUND_COVER_IMAGE_LABEL) {
      return item
    }
  }
  return null
}

export function getSubCompositionThumbnailFrame(composition: SubComposition): number {
  const cover = findCoverImageItem(composition)
  if (cover) {
    // Render mid-cover so any fade-in/out lands on a settled frame.
    return Math.max(0, Math.floor(cover.durationInFrames / 2))
  }

  const { durationInFrames } = composition
  if (durationInFrames <= 1) {
    return 0
  }
  return Math.min(durationInFrames - 1, Math.max(0, Math.round((durationInFrames - 1) * 0.2)))
}
