import { create } from 'zustand'

interface AddCoverDialogState {
  isOpen: boolean
  /** Compound clip's compositionId targeted by the dialog. */
  compositionId: string | null
  open: (compositionId: string) => void
  close: () => void
}

export const useAddCoverDialogStore = create<AddCoverDialogState>((set) => ({
  isOpen: false,
  compositionId: null,
  open: (compositionId) => set({ isOpen: true, compositionId }),
  close: () => set({ isOpen: false, compositionId: null }),
}))
