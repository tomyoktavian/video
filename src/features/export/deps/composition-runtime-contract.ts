/**
 * Adapter exports for composition-runtime dependencies.
 * Export modules should import composition-runtime utilities from here.
 */

export {
  resolveTransform,
  getSourceDimensions,
} from '@/runtime/composition-runtime/utils/transform-resolver'
export {
  applyTransformOverride,
  createFrameCompositionSceneCache,
  resolveItemTransformAtFrame,
  resolveActiveShapeMasksAtFrame,
  resolveFrameCompositionScene,
  resolveFrameCompositionSceneCached,
  invalidateFrameSceneCache,
} from '@/runtime/composition-runtime/utils/frame-scene'
export {
  applyPreviewPathVerticesToItem,
  applyPreviewPathVerticesToShape,
  type PreviewPathVerticesOverride,
} from '@/runtime/composition-runtime/utils/preview-path-override'
export { expandTextTransformToFitContent } from '@/runtime/composition-runtime/utils/text-layout'
export {
  resolveTrackRenderState,
  resolveCompositionRenderPlan,
  collectTransitionClipItems,
  buildItemIdMap,
  resolveTransitionWindowsForItems,
  collectVisibleAdjustmentLayers,
  buildFrameRenderTasks,
  collectFrameVideoCandidates,
  groupTransitionsByTrackOrder,
  resolveOcclusionCutoffOrder,
  resolveFrameRenderScene,
} from '@/runtime/composition-runtime/utils/scene-assembly'
export {
  calculateTransitionProgress,
  resolveTransitionFrameState,
} from '@/runtime/composition-runtime/utils/transition-scene'
export { getShapePath, rotatePath } from '@/runtime/composition-runtime/utils/shape-path'
export {
  hasCornerPin,
  computeCornerPinHomography,
  invertCornerPinHomography,
  drawCornerPinImage,
  resolveCornerPinTargetRect,
  resolveCornerPinForSize,
} from '@/runtime/composition-runtime/utils/corner-pin'
export {
  getVideoTargetTimeSeconds,
  snapSourceTime,
} from '@/runtime/composition-runtime/utils/video-timing'
