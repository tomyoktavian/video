import { create } from 'zustand'

interface SpoilerGeneratorDialogState {
  isOpen: boolean
  /** Source film media id triggered from the media library context menu. */
  mediaId: string | null
  open: (mediaId: string) => void
  close: () => void
}

export const useSpoilerGeneratorDialogStore = create<SpoilerGeneratorDialogState>((set) => ({
  isOpen: false,
  mediaId: null,
  open: (mediaId) => set({ isOpen: true, mediaId }),
  close: () => set({ isOpen: false, mediaId: null }),
}))
