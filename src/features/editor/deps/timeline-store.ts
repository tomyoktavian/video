/**
 * Adapter exports for timeline store dependencies.
 * Editor modules should import timeline store types/selectors from here.
 */

export type { TimelineState, TimelineActions, SubComposition } from './timeline-contract'
export {
  importWaveformCache,
  rateStretchItemWithoutHistory,
  useTimelineStore,
  useTimelineSettingsStore,
  useItemsStore,
  useKeyframesStore,
  useCompositionsStore,
  useCompositionNavigationStore,
  useTimelineCommandStore,
  captureSnapshot,
  buildSubCompositionInput,
  buildSubCompositionPreviewSignature,
  collectSubCompositionMediaIds,
  getSubCompositionThumbnailFrame,
} from './timeline-contract'
