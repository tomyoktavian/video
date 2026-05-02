/**
 * Cross-feature contract — Compound Cover service. Used by Spoiler
 * Generator's cover insertion stage to render a frame, persist it, and
 * insert a Vlog-style title card at the head of the spoiler compound.
 */

export { insertCover } from '@/features/compound-cover/insert-cover-action'
export { renderCoverFrame, persistCoverFrame } from '@/features/compound-cover/frame-extraction'
