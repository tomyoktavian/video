/**
 * Compatibility adapter that re-exports through timeline-contract.
 */

export {
  useCompositionsStore,
  type SubComposition,
  useCompositionNavigationStore,
  useItemsStore,
  buildSubCompositionInput,
  collectSubCompositionMediaIds,
  renderSingleFrame,
  resolveMediaUrl,
  resolveMediaUrls,
  useMediaLibraryStore,
  mediaLibraryService,
  execute,
} from './timeline-contract'

export { getTranscript } from '@/infrastructure/storage'
