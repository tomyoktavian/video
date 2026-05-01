/**
 * Insert a Vlog-style cover at frame 0 of a compound clip's internal timeline.
 *
 * Two routing branches keep the cover visible no matter where the user is:
 *
 *   • **User NOT inside the target comp** → mutate `useCompositionsStore`
 *     directly. The compound clip's stored data picks up the cover and any
 *     wrapper instances on the timeline re-render automatically.
 *
 *   • **User IS inside the target comp** → mutate the LIVE editing copy in
 *     `useItemsStore` (items + tracks + duration). This is the source the
 *     timeline reads while the user edits a sub-comp. We must NOT touch the
 *     compositions-store in this branch, because `saveCurrentToComposition`
 *     would overwrite the SubComposition with the live editing copy on exit
 *     and undo our work twice. The live copy is persisted back to the
 *     compositions-store via the navigation store on exit/navigation.
 *
 * Both branches are wrapped in `execute()` so undo restores either snapshot
 * atomically.
 */

import { createLogger } from '@/shared/logging/logger'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'

import { buildCoverItems, buildCoverTrack } from './build-cover-items'
import {
  execute,
  useCompositionNavigationStore,
  useCompositionsStore,
  useItemsStore,
} from './deps/timeline'

const logger = createLogger('CompoundCover:InsertAction')

export interface InsertCoverParams {
  compositionId: string
  /** Cover duration in seconds. Converted to frames using the comp's fps. */
  durationSec: number
  frameMediaId: string
  frameSrc: string
  frameWidth: number
  frameHeight: number
  primary: string
  accent?: string
  secondary?: string
}

export interface InsertCoverResult {
  trackId: string
  imageItemId: string
  textItemIds: string[]
  coverDurationFrames: number
}

export function insertCover(params: InsertCoverParams): InsertCoverResult {
  const composition = useCompositionsStore.getState().getComposition(params.compositionId)
  if (!composition) {
    throw new Error(`Compound clip ${params.compositionId} not found.`)
  }
  if (params.primary.trim().length === 0) {
    throw new Error('Cover requires at least a primary title.')
  }
  if (params.durationSec <= 0) {
    throw new Error('Cover duration must be greater than 0.')
  }

  const fps = composition.fps > 0 ? composition.fps : 30
  const coverDurationFrames = Math.max(1, Math.round(params.durationSec * fps))

  const coverTrack = buildCoverTrack(composition.tracks)
  const { image, texts } = buildCoverItems({
    trackId: coverTrack.id,
    durationInFrames: coverDurationFrames,
    frameMediaId: params.frameMediaId,
    frameSrc: params.frameSrc,
    frameWidth: params.frameWidth,
    frameHeight: params.frameHeight,
    canvasWidth: composition.width,
    canvasHeight: composition.height,
    primary: params.primary,
    ...(params.accent !== undefined ? { accent: params.accent } : {}),
    ...(params.secondary !== undefined ? { secondary: params.secondary } : {}),
  })

  const isActive =
    useCompositionNavigationStore.getState().activeCompositionId === params.compositionId

  return execute(
    'COMPOUND_COVER_INSERT',
    () => {
      if (isActive) {
        applyToLiveEditingCopy({
          coverTrack,
          coverItems: [image, ...texts],
          coverDurationFrames,
        })
      } else {
        applyToCompositionsStore({
          compositionId: params.compositionId,
          coverTrack,
          coverItems: [image, ...texts],
          coverDurationFrames,
        })
      }

      logger.info('Cover inserted', {
        compositionId: params.compositionId,
        coverDurationFrames,
        textItemCount: texts.length,
        target: isActive ? 'live-editing-copy' : 'compositions-store',
      })

      return {
        trackId: coverTrack.id,
        imageItemId: image.id,
        textItemIds: texts.map((t) => t.id),
        coverDurationFrames,
      }
    },
    {
      compositionId: params.compositionId,
      coverDurationFrames,
      target: isActive ? 'live' : 'composition',
    },
  )
}

interface ApplyParams {
  coverTrack: TimelineTrack
  coverItems: TimelineItem[]
  coverDurationFrames: number
}

function applyToLiveEditingCopy({
  coverTrack,
  coverItems,
  coverDurationFrames,
}: ApplyParams): void {
  const itemsStore = useItemsStore.getState()
  const shifted = itemsStore.items.map((item) => ({
    id: item.id,
    from: item.from + coverDurationFrames,
  }))
  itemsStore.setTracks([...itemsStore.tracks, coverTrack])
  if (shifted.length > 0) {
    itemsStore._moveItems(shifted)
  }
  itemsStore._addItems(coverItems)
}

function applyToCompositionsStore({
  compositionId,
  coverTrack,
  coverItems,
  coverDurationFrames,
}: ApplyParams & { compositionId: string }): void {
  const fresh = useCompositionsStore.getState().getComposition(compositionId)
  if (!fresh) {
    throw new Error(`Compound clip ${compositionId} disappeared mid-mutation.`)
  }

  const shiftedItems: TimelineItem[] = fresh.items.map((item) => ({
    ...item,
    from: item.from + coverDurationFrames,
  }))

  useCompositionsStore.getState().updateComposition(compositionId, {
    items: [...shiftedItems, ...coverItems],
    tracks: [...fresh.tracks, coverTrack],
    durationInFrames: fresh.durationInFrames + coverDurationFrames,
  })
}
