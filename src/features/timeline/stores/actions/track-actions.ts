/**
 * Track Actions - Operations on timeline tracks.
 */

import type { TimelineTrack } from '@/types/timeline'
import { useItemsStore } from '../items-store'
import { useTimelineSettingsStore } from '../timeline-settings-store'
import { execute } from './shared'
import { resizeAllTracksInList } from '../../utils/track-resize'
import { MIN_TRACK_HEIGHT } from '../../constants'

export function setTracks(tracks: TimelineTrack[]): void {
  execute(
    'SET_TRACKS',
    () => {
      useItemsStore.getState().setTracks(tracks)
      useTimelineSettingsStore.getState().markDirty()
    },
    { count: tracks.length },
  )
}

export function fitAllTracksToMinHeight(): void {
  const currentTracks = useItemsStore.getState().tracks
  const nextTracks = resizeAllTracksInList(currentTracks, MIN_TRACK_HEIGHT)
  if (nextTracks === currentTracks) return
  setTracks(nextTracks)
}
