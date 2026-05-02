/**
 * Cross-feature contract — direct access to the export feature's render
 * engine, used by the cover-render worker so it can amortize a single
 * `createCompositionRenderer` call across many frames.
 */

export { createCompositionRenderer } from '@/features/export/utils/client-render-engine'
export type { CompositionInputProps } from '@/types/export'
