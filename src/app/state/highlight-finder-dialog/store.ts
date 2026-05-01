import { create } from 'zustand'

interface HighlightFinderDialogState {
  isOpen: boolean
  selectedItemIds: readonly string[]
  open: (selectedItemIds: readonly string[]) => void
  close: () => void
}

export const useHighlightFinderDialogStore = create<HighlightFinderDialogState>((set) => ({
  isOpen: false,
  selectedItemIds: [],
  open: (selectedItemIds) => set({ isOpen: true, selectedItemIds }),
  close: () => set({ isOpen: false, selectedItemIds: [] }),
}))
