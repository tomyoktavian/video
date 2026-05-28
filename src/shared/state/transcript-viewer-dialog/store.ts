import { create } from 'zustand'

interface TranscriptViewerDialogState {
  isOpen: boolean
  mediaId: string | null
  fileName: string | null
  open: (mediaId: string, fileName: string) => void
  close: () => void
}

export const useTranscriptViewerDialogStore = create<TranscriptViewerDialogState>((set) => ({
  isOpen: false,
  mediaId: null,
  fileName: null,
  open: (mediaId, fileName) => set({ isOpen: true, mediaId, fileName }),
  close: () => set({ isOpen: false, mediaId: null, fileName: null }),
}))
