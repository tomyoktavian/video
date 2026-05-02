// Timeline feature — public API
// Multi-track timeline with drag/trim/stretch, transitions, markers, and keyframes

export { useTimelineStore } from './stores/timeline-store'
export { useZoomStore } from './stores/zoom-store'
export { Timeline } from './components/timeline'
export { applyHighlightPlans, type CreatedCompInfo } from './stores/actions/highlight-actions'
export { addItem, addItems } from './stores/actions/item-actions'
export { splitItemAtFrames } from './stores/actions/item-edit-actions'
export { createPreComp } from './stores/actions/composition-actions'
export { useItemsStore } from './stores/items-store'
export { useCompositionsStore } from './stores/compositions-store'
export { useTimelineSettingsStore } from './stores/timeline-settings-store'
export { DEFAULT_TRACK_HEIGHT } from './constants'
