/**
 * Adapter exports for timeline dependencies.
 * Project-bundle modules should import timeline stores/utils from here.
 */

export { useCompositionsStore } from '@/features/timeline/stores/compositions-store'
export type { SubComposition } from '@/features/timeline/stores/compositions-store'
export { collectSubCompositionMediaIds } from '@/features/timeline/utils/sub-composition-preview'
