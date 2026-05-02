import { create } from 'zustand'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import type { AudioEqSettings } from '@/types/audio'
import type { Transition } from '@/types/transition'
import type { ItemKeyframes } from '@/types/keyframe'
import { normalizeSubComposition } from '../utils/sub-composition-normalizer'

/**
 * Generation metadata stamped on compounds produced by the Spoiler Generator.
 * Defined as a structural type here (rather than imported from the feature)
 * to keep this store dependency-free; the spoiler-generator feature owns the
 * authoritative `SpoilerCompositionMetadata` type and casts on read.
 */
export interface SubCompositionSpoilerMetadata {
  version: 1
  generatedAt: number
  segments: ReadonlyArray<{
    index: number
    narrationText: string
    narrationItemId: string
    videoItemId: string
    originalAudioItemId: string | null
    subtitleItemIds: ReadonlyArray<string>
    sourceClipRange: { start: number; end: number }
  }>
  voiceId: string | null
  speed: number
  language: string
  scriptTitle: string
  scriptSynopsis?: string
  addSubtitles: boolean
  /**
   * Words per subtitle text item used when this spoiler was generated.
   * Read by regen-narration so re-built subtitles match the original look.
   * Optional for backward-compat (callers fall back to `1`).
   */
  wordsPerCaption?: number
  /**
   * @deprecated Legacy field from the early word/phrase toggle. New metadata
   * uses {@link wordsPerCaption}; regen-narration still reads this if present
   * to migrate older compounds.
   */
  captionGranularity?: 'word' | 'phrase'
  generateCover: boolean
  includeOriginalAudio: boolean
  sourceFilmMediaId: string
}

/**
 * Sub-composition data — a self-contained mini-timeline stored independently.
 * Multiple CompositionItem instances can reference the same compositionId,
 * enabling reuse of pre-comp contents across the project.
 */
export interface SubComposition {
  id: string
  name: string
  items: TimelineItem[]
  tracks: TimelineTrack[]
  transitions: Transition[]
  keyframes: ItemKeyframes[]
  fps: number
  width: number
  height: number
  durationInFrames: number
  backgroundColor?: string
  busAudioEq?: AudioEqSettings
  /**
   * Present only on compounds produced by the Spoiler Generator. Enables
   * "Regenerate Narration…" right-click to rebuild TTS audio + subtitles
   * in place. Manually-created pre-comps leave this undefined.
   */
  spoilerMetadata?: SubCompositionSpoilerMetadata
}

function buildCompositionsMediaDependencyIds(compositions: SubComposition[]): string[] {
  const mediaIds = new Set<string>()
  for (const composition of compositions) {
    for (const item of composition.items) {
      if (item.mediaId) {
        mediaIds.add(item.mediaId)
      }
    }
  }
  return [...mediaIds].sort()
}

function buildMediaDependencyKey(mediaDependencyIds: string[]): string {
  return mediaDependencyIds.join('|')
}

interface CompositionsState {
  compositions: SubComposition[]
  compositionById: Record<string, SubComposition>
  mediaDependencyIds: string[]
  mediaDependencyVersion: number
}

interface CompositionsActions {
  addComposition: (composition: SubComposition) => void
  updateComposition: (id: string, updates: Partial<Omit<SubComposition, 'id'>>) => void
  removeComposition: (id: string) => void
  getComposition: (id: string) => SubComposition | undefined
  setCompositions: (compositions: SubComposition[]) => void
}

export const useCompositionsStore = create<CompositionsState & CompositionsActions>()(
  (set, get) => ({
    compositions: [],
    compositionById: {},
    mediaDependencyIds: [],
    mediaDependencyVersion: 0,

    addComposition: (composition) =>
      set((state) => ({
        compositions: [...state.compositions, normalizeSubComposition(composition)],
      })),

    updateComposition: (id, updates) =>
      set((state) => ({
        compositions: state.compositions.map((c) =>
          c.id === id ? normalizeSubComposition({ ...c, ...updates }) : c,
        ),
      })),

    removeComposition: (id) =>
      set((state) => ({
        compositions: state.compositions.filter((c) => c.id !== id),
      })),

    getComposition: (id) => get().compositionById[id],

    setCompositions: (compositions) =>
      set({
        compositions: compositions.map((composition) => normalizeSubComposition(composition)),
      }),
  }),
)

let prevCompositionsRef = useCompositionsStore.getState().compositions
let prevCompositionsMediaDependencyIds = useCompositionsStore.getState().mediaDependencyIds
let prevCompositionsMediaDependencyKey = buildMediaDependencyKey(prevCompositionsMediaDependencyIds)
useCompositionsStore.subscribe((state) => {
  if (state.compositions === prevCompositionsRef) {
    return
  }
  prevCompositionsRef = state.compositions
  const compositionById: Record<string, SubComposition> = {}
  for (const composition of state.compositions) {
    compositionById[composition.id] = composition
  }
  const nextMediaDependencyIds = buildCompositionsMediaDependencyIds(state.compositions)
  const nextMediaDependencyKey = buildMediaDependencyKey(nextMediaDependencyIds)
  const mediaDependencyIds =
    nextMediaDependencyKey === prevCompositionsMediaDependencyKey
      ? state.mediaDependencyIds
      : nextMediaDependencyIds
  const mediaDependencyVersion =
    nextMediaDependencyKey === prevCompositionsMediaDependencyKey
      ? state.mediaDependencyVersion
      : state.mediaDependencyVersion + 1
  prevCompositionsMediaDependencyIds = mediaDependencyIds
  prevCompositionsMediaDependencyKey = nextMediaDependencyKey
  useCompositionsStore.setState({
    compositionById,
    mediaDependencyIds: prevCompositionsMediaDependencyIds,
    mediaDependencyVersion,
  })
})
