/**
 * Apply Highlight Finder plans to the timeline.
 *
 * Per the approved plan, this uses the pragmatic N+1-undo-step approach:
 *   - Phase 1: one `splitItemAtFrames` call per selected source item
 *     (handles linked V+A companions and transition repair via the public
 *     split API). Each call = 1 undo step.
 *   - Phase 2: one `createPreComp` call per highlight plan, wrapping the
 *     middle chunk that lives between the two split frames. Each wrap = 1
 *     undo step.
 *
 * Caller (Highlight Finder dialog) drives this after `prepareHighlights`
 * resolves the AI response into `ResolvedHighlightPlan[]`.
 */

import { useItemsStore } from '../items-store'
import { splitItemAtFrames } from './item-edit-actions'
import { createPreComp } from './composition-actions'

/**
 * Structural shape for a resolved highlight plan. Mirrors
 * `@/features/highlight-finder/types#ResolvedHighlightPlan` but re-declared
 * here so the timeline feature does not import from the highlight-finder
 * feature (cross-feature imports must go through `deps/` per project rules).
 */
export interface ResolvedHighlightPlan {
  itemId: string
  splitFrames: [number, number]
  title: string
  mediaId?: string
  sourceStartSec?: number
  sourceEndSec?: number
  fps?: number
  titleStyle?: string
}

export interface CreatedCompInfo {
  compId: string
  from: number
  durationInFrames: number
  /** Index into the original plans array. */
  planIndex: number
}

export interface ApplyHighlightPlansResult {
  compIds: string[]
  createdComps: readonly CreatedCompInfo[]
  /** Plans that produced no compound clip (e.g. middle chunk vanished due to overlap). */
  failed: number
}

export function applyHighlightPlans(
  plans: readonly ResolvedHighlightPlan[],
  companionItemIdsByPlanIndex?: ReadonlyMap<number, readonly string[]>,
): ApplyHighlightPlansResult {
  if (plans.length === 0) return { compIds: [], createdComps: [], failed: 0 }

  // Snapshot the original mediaId per item before splitting so we can later
  // identify the right "middle" piece by (mediaId, from, durationInFrames).
  const originalMediaIdByItemId = new Map<string, string | undefined>()
  for (const plan of plans) {
    if (originalMediaIdByItemId.has(plan.itemId)) continue
    const item = useItemsStore.getState().itemById[plan.itemId]
    originalMediaIdByItemId.set(plan.itemId, item?.mediaId)
  }

  // Phase 1 — splits.
  // Group split frames by the source item id, dedupe, and call the public
  // batched split API once per item. Each call is its own undo step.
  const splitFramesByItem = new Map<string, Set<number>>()
  for (const plan of plans) {
    if (!splitFramesByItem.has(plan.itemId)) splitFramesByItem.set(plan.itemId, new Set())
    const set = splitFramesByItem.get(plan.itemId)!
    set.add(plan.splitFrames[0])
    set.add(plan.splitFrames[1])
  }
  for (const [itemId, frameSet] of splitFramesByItem) {
    const frames = Array.from(frameSet)
    splitItemAtFrames(itemId, frames)
  }

  // Phase 2 — identify middle pieces and wrap.
  // After the split, each plan's middle chunk should be an item with:
  //   - from === plan.splitFrames[0]
  //   - durationInFrames === plan.splitFrames[1] - plan.splitFrames[0]
  //   - mediaId === the original item's mediaId
  // If multiple items match (e.g. linked audio companion at the same time
  // window), `createPreComp` will pull in the linked partner via its
  // `expandSelectionWithLinkedItems` step — we just need the visual one.
  const compIds: string[] = []
  const createdComps: CreatedCompInfo[] = []
  let failed = 0

  plans.forEach((plan, planIndex) => {
    const expectedFrom = plan.splitFrames[0]
    const expectedDuration = plan.splitFrames[1] - plan.splitFrames[0]
    const expectedMediaId = originalMediaIdByItemId.get(plan.itemId)
    const items = useItemsStore.getState().items
    const candidates = items.filter(
      (item) =>
        item.from === expectedFrom &&
        item.durationInFrames === expectedDuration &&
        item.mediaId === expectedMediaId,
    )
    // Prefer a video candidate; fall back to the first match.
    const middle = candidates.find((item) => item.type === 'video') ?? candidates[0]
    if (!middle) {
      failed += 1
      return
    }

    const companions = companionItemIdsByPlanIndex?.get(planIndex) ?? []
    const comp = createPreComp(plan.title, [middle.id, ...companions])
    if (comp) {
      compIds.push(comp.id)
      createdComps.push({
        compId: comp.id,
        from: expectedFrom,
        durationInFrames: expectedDuration,
        planIndex,
      })
    } else {
      failed += 1
    }
  })

  return { compIds, createdComps, failed }
}
