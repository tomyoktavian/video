/**
 * Cross-feature contract — Timeline mutators and stores used by Spoiler
 * Generator's compound assembly stage. Reuses the public action API
 * (addItems, splitItemAtFrames, createPreComp) so all mutations integrate
 * with the undo/redo stack via `execute()`.
 */

export {
  useItemsStore,
  useCompositionsStore,
  useTimelineSettingsStore,
  addItem,
  addItems,
  splitItemAtFrames,
  createPreComp,
  DEFAULT_TRACK_HEIGHT,
} from '@/features/timeline'

export { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store'

export { execute, applyTransitionRepairs } from '@/features/timeline/stores/actions/shared'

export type { SubComposition } from '@/features/timeline/stores/compositions-store'
