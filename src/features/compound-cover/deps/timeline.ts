/**
 * Cross-feature contract — timeline / composition / media-library access for
 * the Add Cover feature. Centralised so the feature module's other files
 * import through this single shim instead of reaching into other features.
 */

export {
  useCompositionsStore,
  type SubComposition,
} from '@/features/timeline/stores/compositions-store'

export { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store'

export { useItemsStore } from '@/features/timeline/stores/items-store'

export {
  buildSubCompositionInput,
  collectSubCompositionMediaIds,
} from '@/features/timeline/utils/sub-composition-preview'

export { renderSingleFrame } from '@/features/export/utils/canvas-render-orchestrator'

export { resolveMediaUrl, resolveMediaUrls } from '@/features/timeline/deps/media-library-resolver'

export { useMediaLibraryStore } from '@/features/timeline/deps/media-library-store'

export { mediaLibraryService } from '@/features/media-library/services/media-library-service'

export { execute } from '@/features/timeline/stores/actions/shared'

export { getTranscript } from '@/infrastructure/storage'
