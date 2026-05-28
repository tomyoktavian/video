import { create } from 'zustand'

interface TrackCaptionsDialogState {
  isOpen: boolean
  /** Track id whose audio clips will be batch-transcribed. */
  trackId: string | null
  open: (trackId: string) => void
  close: () => void
}

export const useTrackCaptionsDialogStore = create<TrackCaptionsDialogState>((set) => ({
  isOpen: false,
  trackId: null,
  open: (trackId) => set({ isOpen: true, trackId }),
  close: () => set({ isOpen: false, trackId: null }),
}))
