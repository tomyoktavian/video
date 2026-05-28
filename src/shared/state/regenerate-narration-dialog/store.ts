import { create } from 'zustand'

interface RegenerateNarrationDialogState {
  isOpen: boolean
  /** Compound clip's compositionId targeted by the dialog. */
  compositionId: string | null
  open: (compositionId: string) => void
  close: () => void
}

export const useRegenerateNarrationDialogStore = create<RegenerateNarrationDialogState>((set) => ({
  isOpen: false,
  compositionId: null,
  open: (compositionId) => set({ isOpen: true, compositionId }),
  close: () => set({ isOpen: false, compositionId: null }),
}))
