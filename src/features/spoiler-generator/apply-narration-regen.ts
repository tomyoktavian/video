/**
 * Apply Narration Regeneration — in-place mutation of a Spoiler-generated
 * compound clip. Mirrors the dual-branch pattern from compound-cover's
 * `insertCover`:
 *
 *   • User NOT inside the target comp → mutate `useCompositionsStore`.
 *   • User IS inside the target comp → mutate the live editing copy in
 *     `useItemsStore` (the source the timeline reads while editing).
 *
 * Both branches are wrapped in `execute()` so undo restores the prior state
 * atomically.
 *
 * Strategy ("durations follow new narration"):
 *   1. For each segment with new TTS audio, swap the narration AudioItem's
 *      `mediaId` / `src` / duration.
 *   2. Stretch the matching VideoItem and OriginalAudioItem to the new
 *      segment duration (= new narration + 0.3s buffer).
 *   3. Rebuild subtitle TextItems for segments that originally had them.
 *      Regen does NOT re-transcribe (would burn API tokens), so the rebuild
 *      uses the fallback path: one TextItem per segment showing the full
 *      narration text spanning the new segment duration. Word-level karaoke
 *      timing only exists on the initial generation pass.
 *   4. Recompute `from` for every other item in the compound — items inside
 *      a regenerated segment shift relative to the segment's new start,
 *      items outside any segment (e.g. cover) keep their absolute offset
 *      and shift only by the cumulative delta from preceding segments.
 *   5. Update `composition.durationInFrames` and bump `spoilerMetadata`.
 */

import { createLogger } from '@/shared/logging/logger'
import type { TimelineItem } from '@/types/timeline'

import { buildSpoilerSubtitleItemsForSegment } from './compound-assembly'
import {
  applyTransitionRepairs,
  execute,
  useCompositionNavigationStore,
  useCompositionsStore,
  useItemsStore,
} from './deps/timeline'
import type { SpoilerCompositionMetadata, SpoilerSegmentMetadata } from './types'

const NARRATION_BUFFER_SEC = 0.3

const logger = createLogger('SpoilerRegen:Apply')

export interface NarrationRegenSegmentInput {
  index: number
  /** New media library id of the regenerated narration audio. */
  mediaId: string
  /** Object URL pointing to the new narration audio blob. */
  blobUrl: string
  /** Measured duration of the new narration audio. */
  durationSec: number
}

export interface ApplyNarrationRegenParams {
  compositionId: string
  regenSegments: readonly NarrationRegenSegmentInput[]
  /** Voice id used for the regen — persisted into spoilerMetadata. */
  voiceId: string | null
  /** Speed used for the regen — persisted. */
  speed: number
  /** Language used for the regen — persisted. */
  language: string
}

export interface NarrationRegenResult {
  segmentsChanged: number
  totalDurationFrames: number
  /** Set of clip ids whose duration changed (for transition repair). */
  changedClipIds: ReadonlyArray<string>
}

interface PreparedSegment {
  metadata: SpoilerSegmentMetadata
  regen: NarrationRegenSegmentInput | null
  oldSegmentFrames: number
  newSegmentFrames: number
  newNarrationFrames: number
}

export function applyNarrationRegen(params: ApplyNarrationRegenParams): NarrationRegenResult {
  const composition = useCompositionsStore.getState().getComposition(params.compositionId)
  if (!composition) {
    throw new Error(`Compound clip ${params.compositionId} not found.`)
  }
  const metadata = composition.spoilerMetadata
  if (!metadata) {
    throw new Error('Cannot regenerate: compound has no spoilerMetadata.')
  }

  const isActive =
    useCompositionNavigationStore.getState().activeCompositionId === params.compositionId

  // Source-of-truth for current item layout — read from the live editing
  // copy when we're inside the comp; otherwise from the stored composition.
  const liveItems = isActive ? useItemsStore.getState().items : composition.items
  const itemById = new Map(liveItems.map((item) => [item.id, item]))

  const fps = composition.fps > 0 ? composition.fps : 30
  const bufferFrames = Math.max(1, Math.round(NARRATION_BUFFER_SEC * fps))

  // Index regen results by segment index for quick lookup.
  const regenByIndex = new Map<number, NarrationRegenSegmentInput>()
  for (const seg of params.regenSegments) {
    regenByIndex.set(seg.index, seg)
  }

  // Pre-compute new vs old segment durations + cumulative shifts.
  const prepared: PreparedSegment[] = metadata.segments.map((segMeta) => {
    const videoItem = itemById.get(segMeta.videoItemId)
    const oldSegmentFrames = videoItem?.durationInFrames ?? 0
    const regen = regenByIndex.get(segMeta.index) ?? null
    const newNarrationFrames = regen ? Math.max(1, Math.round(regen.durationSec * fps)) : 0
    // Failed segments (no regen entry) keep their old duration.
    const newSegmentFrames = regen
      ? Math.max(1, newNarrationFrames + bufferFrames)
      : oldSegmentFrames
    return {
      metadata: segMeta,
      regen,
      oldSegmentFrames,
      newSegmentFrames,
      newNarrationFrames,
    }
  })

  // Build set of all segment item ids — items "inside" any regenerated segment.
  const segmentItemIds = new Set<string>()
  for (const seg of metadata.segments) {
    segmentItemIds.add(seg.videoItemId)
    if (seg.originalAudioItemId) segmentItemIds.add(seg.originalAudioItemId)
    if (seg.narrationItemId) segmentItemIds.add(seg.narrationItemId)
    for (const sid of seg.subtitleItemIds) segmentItemIds.add(sid)
  }

  // Determine each segment's old `from` (start frame) — we need this to
  // identify out-of-segment items (e.g. cover) and to compute new `from`s.
  const oldSegmentStartByIndex = new Map<number, number>()
  for (const segMeta of metadata.segments) {
    const videoItem = itemById.get(segMeta.videoItemId)
    if (videoItem) oldSegmentStartByIndex.set(segMeta.index, videoItem.from)
  }

  // Compute new segment starts (cumulative new durations from a fixed origin).
  // Origin = old start of segment 0 — preserves cover/lead-in placement.
  const firstStart = oldSegmentStartByIndex.get(metadata.segments[0]!.index) ?? 0
  const newSegmentStartByIndex = new Map<number, number>()
  let cursor = firstStart
  for (const p of prepared) {
    newSegmentStartByIndex.set(p.metadata.index, cursor)
    cursor += p.newSegmentFrames
  }
  const newSegmentsTotalEnd = cursor
  const oldSegmentsTotalEnd =
    (oldSegmentStartByIndex.get(metadata.segments[metadata.segments.length - 1]!.index) ?? 0) +
    (prepared[prepared.length - 1]?.oldSegmentFrames ?? 0)
  const tailDelta = newSegmentsTotalEnd - oldSegmentsTotalEnd

  // -- Build mutation lists --
  const itemsToUpdate: Array<{ id: string; updates: Partial<TimelineItem> }> = []
  const itemsToRemove: string[] = []
  const itemsToAdd: TimelineItem[] = []
  const newSegmentsMetadata: SpoilerSegmentMetadata[] = []
  const changedClipIds: string[] = []

  for (const p of prepared) {
    const segStart = newSegmentStartByIndex.get(p.metadata.index)!
    const newSegmentFrames = p.newSegmentFrames

    // Video item — stretch + reposition.
    const videoItem = itemById.get(p.metadata.videoItemId)
    if (videoItem) {
      const sourceFps = videoItem.sourceFps ?? fps
      const sourceStart = videoItem.sourceStart ?? 0
      const sourceFramesForClip = Math.max(1, Math.round((newSegmentFrames * sourceFps) / fps))
      const sourceEnd = sourceStart + sourceFramesForClip
      itemsToUpdate.push({
        id: videoItem.id,
        updates: {
          from: segStart,
          durationInFrames: newSegmentFrames,
          sourceEnd,
        },
      })
      changedClipIds.push(videoItem.id)
    }

    // Original audio item — same as video.
    if (p.metadata.originalAudioItemId) {
      const oaItem = itemById.get(p.metadata.originalAudioItemId)
      if (oaItem) {
        const sourceFps = oaItem.sourceFps ?? fps
        const sourceStart = oaItem.sourceStart ?? 0
        const sourceFramesForClip = Math.max(1, Math.round((newSegmentFrames * sourceFps) / fps))
        const sourceEnd = sourceStart + sourceFramesForClip
        itemsToUpdate.push({
          id: oaItem.id,
          updates: {
            from: segStart,
            durationInFrames: newSegmentFrames,
            sourceEnd,
          },
        })
        changedClipIds.push(oaItem.id)
      }
    }

    // Narration item — swap media + reposition + restretch. The id itself
    // is preserved (we mutate via `_updateItem`), so the stored mapping in
    // `spoilerMetadata.segments[i].narrationItemId` doesn't need updating.
    if (p.regen) {
      const narrationItem = itemById.get(p.metadata.narrationItemId)
      if (narrationItem) {
        itemsToUpdate.push({
          id: narrationItem.id,
          updates: {
            from: segStart,
            mediaId: p.regen.mediaId,
            // src lives on AudioItem only — TS keeps it on the union via
            // Partial<TimelineItem>; at runtime the store does a flat merge.
            src: p.regen.blobUrl,
            durationInFrames: Math.min(p.newNarrationFrames, newSegmentFrames),
            sourceStart: 0,
            sourceEnd: p.newNarrationFrames,
            sourceDuration: p.newNarrationFrames,
            sourceFps: fps,
          } as Partial<TimelineItem>,
        })
        changedClipIds.push(narrationItem.id)
      }
    } else if (p.metadata.narrationItemId) {
      // Failed / skipped regen — still reposition existing item.
      const narrationItem = itemById.get(p.metadata.narrationItemId)
      if (narrationItem && narrationItem.from !== segStart) {
        itemsToUpdate.push({
          id: narrationItem.id,
          updates: { from: segStart },
        })
      }
    }

    // Subtitle items — remove old, build new (only when this compound was
    // originally generated with subtitles AND this segment got new audio).
    // We never re-transcribe on regen (saves API tokens), so the rebuild
    // uses the fallback path: one TextItem per segment with the full
    // narration text spanning the new segment duration.
    let nextSubtitleIds: string[] = [...p.metadata.subtitleItemIds]
    if (metadata.addSubtitles && p.regen) {
      // Find the subtitle track id from any old subtitle item.
      const firstOldSubtitle = p.metadata.subtitleItemIds
        .map((id) => itemById.get(id))
        .find((item) => item !== undefined)
      const subtitleTrackId = firstOldSubtitle?.trackId

      if (subtitleTrackId) {
        // Remove old subtitle items.
        for (const id of p.metadata.subtitleItemIds) {
          if (itemById.has(id)) itemsToRemove.push(id)
        }

        // Build new ones (no transcript → fallback path: 1 item per segment).
        const newSubtitleItems = buildSpoilerSubtitleItemsForSegment({
          trackId: subtitleTrackId,
          segment: {
            index: p.metadata.index,
            sourceStartSec: p.metadata.sourceClipRange.start,
            sourceEndSec: p.metadata.sourceClipRange.end,
            narration: p.metadata.narrationText,
            finalDurationSec: newSegmentFrames / fps,
          },
          cursorFrame: segStart,
          segmentDurationFrames: newSegmentFrames,
          fps,
          canvasWidth: composition.width,
          canvasHeight: composition.height,
          transcript: undefined,
          ...(typeof metadata.wordsPerCaption === 'number'
            ? { wordsPerCaption: metadata.wordsPerCaption }
            : metadata.captionGranularity === 'phrase'
              ? { wordsPerCaption: 5 }
              : metadata.captionGranularity === 'word'
                ? { wordsPerCaption: 1 }
                : {}),
        })
        for (const item of newSubtitleItems) itemsToAdd.push(item)
        nextSubtitleIds = newSubtitleItems.map((item) => item.id)
      }
    }

    newSegmentsMetadata.push({
      index: p.metadata.index,
      narrationText: p.metadata.narrationText,
      narrationItemId: p.metadata.narrationItemId,
      videoItemId: p.metadata.videoItemId,
      originalAudioItemId: p.metadata.originalAudioItemId,
      subtitleItemIds: nextSubtitleIds,
      sourceClipRange: { ...p.metadata.sourceClipRange },
    })
  }

  // Out-of-segment items (e.g. cover image + cover text):
  //   - Items strictly BEFORE the first segment: leave `from` unchanged.
  //   - Items AT/AFTER the old end of segments: shift by `tailDelta`.
  //   - Items already covered by `segmentItemIds` are handled above.
  if (tailDelta !== 0) {
    for (const item of liveItems) {
      if (segmentItemIds.has(item.id)) continue
      if (item.from >= oldSegmentsTotalEnd) {
        itemsToUpdate.push({ id: item.id, updates: { from: item.from + tailDelta } })
      }
    }
  }

  return execute(
    'SPOILER_NARRATION_REGEN',
    () => {
      if (isActive) {
        applyToLiveEditingCopy({
          itemsToUpdate,
          itemsToRemove,
          itemsToAdd,
        })
      } else {
        applyToCompositionsStore({
          compositionId: params.compositionId,
          itemsToUpdate,
          itemsToRemove,
          itemsToAdd,
          newDurationFrames: composition.durationInFrames + tailDelta,
        })
      }

      // Update spoilerMetadata regardless of branch — it lives on the
      // SubComposition record only.
      const nextMetadata: SpoilerCompositionMetadata = {
        ...metadata,
        version: 1,
        generatedAt: Date.now(),
        segments: newSegmentsMetadata,
        voiceId: params.voiceId,
        speed: params.speed,
        language: params.language,
      }
      useCompositionsStore.getState().updateComposition(params.compositionId, {
        spoilerMetadata: nextMetadata,
        // When inactive the duration was set above; when active we still
        // want the SubComposition record to know the new length so that
        // `saveCurrentToComposition` doesn't overwrite with the old.
        durationInFrames: composition.durationInFrames + tailDelta,
      })

      if (changedClipIds.length > 0) {
        applyTransitionRepairs(changedClipIds)
      }

      logger.info('Narration regenerated', {
        compositionId: params.compositionId,
        segmentsChanged: prepared.filter((p) => p.regen !== null).length,
        tailDelta,
        target: isActive ? 'live-editing-copy' : 'compositions-store',
      })

      return {
        segmentsChanged: prepared.filter((p) => p.regen !== null).length,
        totalDurationFrames: composition.durationInFrames + tailDelta,
        changedClipIds,
      }
    },
    {
      compositionId: params.compositionId,
      target: isActive ? 'live' : 'composition',
    },
  )
}

interface ApplyParams {
  itemsToUpdate: Array<{ id: string; updates: Partial<TimelineItem> }>
  itemsToRemove: string[]
  itemsToAdd: TimelineItem[]
}

function applyToLiveEditingCopy(params: ApplyParams): void {
  const itemsStore = useItemsStore.getState()
  for (const update of params.itemsToUpdate) {
    itemsStore._updateItem(update.id, update.updates)
  }
  if (params.itemsToRemove.length > 0) {
    itemsStore._removeItems(params.itemsToRemove)
  }
  if (params.itemsToAdd.length > 0) {
    itemsStore._addItems(params.itemsToAdd)
  }
}

function applyToCompositionsStore(
  params: ApplyParams & { compositionId: string; newDurationFrames: number },
): void {
  const fresh = useCompositionsStore.getState().getComposition(params.compositionId)
  if (!fresh) {
    throw new Error(`Compound clip ${params.compositionId} disappeared mid-mutation.`)
  }

  const updateMap = new Map<string, Partial<TimelineItem>>()
  for (const u of params.itemsToUpdate) updateMap.set(u.id, u.updates)
  const removeSet = new Set(params.itemsToRemove)

  const nextItems: TimelineItem[] = []
  for (const item of fresh.items) {
    if (removeSet.has(item.id)) continue
    const updates = updateMap.get(item.id)
    nextItems.push(updates ? ({ ...item, ...updates } as TimelineItem) : item)
  }
  for (const newItem of params.itemsToAdd) nextItems.push(newItem)

  useCompositionsStore.getState().updateComposition(params.compositionId, {
    items: nextItems,
    durationInFrames: params.newDurationFrames,
  })
}
