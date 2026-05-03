import { create } from 'zustand'

/**
 * Image source for the bulk "Set cover to compound" dialog.
 *
 * - `media-library`: image already persisted; we have its mediaId + resolved src.
 * - `unsaved-blob`: image is in memory only (e.g. a freshly generated AI image
 *   that the user has not yet saved). The dialog will lazily call
 *   `mediaLibraryService.importGeneratedImage` on submit so cancelling does
 *   not pollute the library.
 */
export type SetCoverImageSource =
  | {
      kind: 'media-library'
      mediaId: string
      src: string
      width: number
      height: number
    }
  | {
      kind: 'unsaved-blob'
      file: File
      objectUrl: string
      width: number
      height: number
      tags?: readonly string[]
      promptSnippet?: string
    }

interface SetCoverToCompoundsDialogState {
  isOpen: boolean
  source: SetCoverImageSource | null
  open: (source: SetCoverImageSource) => void
  close: () => void
}

export const useSetCoverToCompoundsDialogStore = create<SetCoverToCompoundsDialogState>((set) => ({
  isOpen: false,
  source: null,
  open: (source) => set({ isOpen: true, source }),
  close: () => set({ isOpen: false, source: null }),
}))
