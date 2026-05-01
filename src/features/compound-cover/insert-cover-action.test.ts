import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

interface FakeSubComposition {
  id: string
  name: string
  fps: number
  width: number
  height: number
  durationInFrames: number
  items: TimelineItem[]
  tracks: TimelineTrack[]
  transitions: never[]
  keyframes: never[]
}

interface ItemsStoreSnapshot {
  items: TimelineItem[]
  tracks: TimelineTrack[]
  setTracksCalls: TimelineTrack[][]
  moveItemsCalls: Array<Array<{ id: string; from: number; trackId?: string }>>
  addItemsCalls: TimelineItem[][]
}

const fakeStore: {
  composition: FakeSubComposition | null
  updateCalls: Array<{ id: string; updates: Partial<FakeSubComposition> }>
  activeCompositionId: string | null
  itemsStore: ItemsStoreSnapshot
} = {
  composition: null,
  updateCalls: [],
  activeCompositionId: null,
  itemsStore: { items: [], tracks: [], setTracksCalls: [], moveItemsCalls: [], addItemsCalls: [] },
}

vi.mock('./deps/timeline', () => ({
  useCompositionsStore: {
    getState: () => ({
      getComposition: (id: string) =>
        fakeStore.composition?.id === id ? fakeStore.composition : undefined,
      updateComposition: (id: string, updates: Partial<FakeSubComposition>) => {
        fakeStore.updateCalls.push({ id, updates })
        if (fakeStore.composition?.id === id) {
          Object.assign(fakeStore.composition, updates)
        }
      },
    }),
  },
  useCompositionNavigationStore: {
    getState: () => ({ activeCompositionId: fakeStore.activeCompositionId }),
  },
  useItemsStore: {
    getState: () => ({
      get items() {
        return fakeStore.itemsStore.items
      },
      get tracks() {
        return fakeStore.itemsStore.tracks
      },
      setTracks: (tracks: TimelineTrack[]) => {
        fakeStore.itemsStore.setTracksCalls.push(tracks)
        fakeStore.itemsStore.tracks = tracks
      },
      _moveItems: (updates: Array<{ id: string; from: number; trackId?: string }>) => {
        fakeStore.itemsStore.moveItemsCalls.push(updates)
        const updateMap = new Map(updates.map((u) => [u.id, u]))
        fakeStore.itemsStore.items = fakeStore.itemsStore.items.map((item) => {
          const update = updateMap.get(item.id)
          return update
            ? { ...item, from: update.from, ...(update.trackId ? { trackId: update.trackId } : {}) }
            : item
        })
      },
      _addItems: (items: TimelineItem[]) => {
        fakeStore.itemsStore.addItemsCalls.push(items)
        fakeStore.itemsStore.items = [...fakeStore.itemsStore.items, ...items]
      },
    }),
  },
  // execute() is a passthrough so the mutation runs synchronously and the
  // test can read back the new composition state.
  execute: <T>(_type: string, action: () => T): T => action(),
}))

import { insertCover } from './insert-cover-action'

function makeItem(id: string, from: number, durationInFrames: number): TimelineItem {
  return {
    id,
    type: 'video',
    trackId: 'track-1',
    from,
    durationInFrames,
    label: id,
    src: 'blob:test',
  } satisfies TimelineItem
}

function makeTrack(id: string, order: number): TimelineTrack {
  return {
    id,
    name: id,
    kind: 'video',
    height: 40,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    order,
    items: [],
  }
}

function seedComposition(): FakeSubComposition {
  return {
    id: 'comp-1',
    name: 'Comp',
    fps: 30,
    width: 1920,
    height: 1080,
    durationInFrames: 300,
    items: [makeItem('a', 0, 60), makeItem('b', 60, 240)],
    tracks: [makeTrack('track-1', 0)],
    transitions: [],
    keyframes: [],
  }
}

beforeEach(() => {
  fakeStore.composition = null
  fakeStore.updateCalls = []
  fakeStore.activeCompositionId = null
  fakeStore.itemsStore = {
    items: [],
    tracks: [],
    setTracksCalls: [],
    moveItemsCalls: [],
    addItemsCalls: [],
  }
})

describe('insertCover — compositions-store branch (user not inside the comp)', () => {
  it('shifts every existing item right by the cover duration and prepends the cover at frame 0', () => {
    fakeStore.composition = seedComposition()

    const result = insertCover({
      compositionId: 'comp-1',
      durationSec: 3, // 3 * 30 fps = 90 frames
      frameMediaId: 'media-cover',
      frameSrc: 'blob:cover',
      frameWidth: 1920,
      frameHeight: 1080,
      primary: 'TEKNIK',
      accent: 'JAGO NGOMONG',
    })

    expect(result.coverDurationFrames).toBe(90)
    expect(fakeStore.updateCalls).toHaveLength(1)
    const update = fakeStore.updateCalls[0]!
    expect(update.id).toBe('comp-1')
    expect(update.updates.durationInFrames).toBe(390)

    const items = update.updates.items!
    const shifted = items.filter((i) => i.id === 'a' || i.id === 'b')
    expect(shifted.find((i) => i.id === 'a')?.from).toBe(90)
    expect(shifted.find((i) => i.id === 'b')?.from).toBe(150)

    const coverItems = items.filter((i) => i.from === 0)
    // image + 2 text items (primary + accent)
    expect(coverItems).toHaveLength(3)
    const image = coverItems.find((i) => i.type === 'image')
    expect(image).toBeDefined()
    expect(image?.mediaId).toBe('media-cover')

    const tracks = update.updates.tracks!
    expect(tracks).toHaveLength(2)
    expect(tracks.some((t) => t.name === 'Cover')).toBe(true)

    // Live items-store must not be touched in this branch.
    expect(fakeStore.itemsStore.setTracksCalls).toHaveLength(0)
    expect(fakeStore.itemsStore.moveItemsCalls).toHaveLength(0)
    expect(fakeStore.itemsStore.addItemsCalls).toHaveLength(0)
  })

  it('throws when the composition does not exist', () => {
    expect(() =>
      insertCover({
        compositionId: 'missing',
        durationSec: 3,
        frameMediaId: 'media-cover',
        frameSrc: 'blob:cover',
        frameWidth: 100,
        frameHeight: 100,
        primary: 'X',
      }),
    ).toThrowError(/missing/)
  })

  it('rejects empty primary text', () => {
    fakeStore.composition = {
      id: 'comp-1',
      name: 'Comp',
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 300,
      items: [],
      tracks: [],
      transitions: [],
      keyframes: [],
    }

    expect(() =>
      insertCover({
        compositionId: 'comp-1',
        durationSec: 3,
        frameMediaId: 'media-cover',
        frameSrc: 'blob:cover',
        frameWidth: 100,
        frameHeight: 100,
        primary: '   ',
      }),
    ).toThrowError(/primary title/)
  })
})

describe('insertCover — live-editing-copy branch (user inside the comp)', () => {
  it('shifts items in items-store, adds the Cover track, and adds cover items there instead of touching compositions-store', () => {
    const comp = seedComposition()
    fakeStore.composition = comp
    fakeStore.activeCompositionId = comp.id
    fakeStore.itemsStore.items = [makeItem('a', 0, 60), makeItem('b', 60, 240)]
    fakeStore.itemsStore.tracks = [makeTrack('track-1', 0)]

    const result = insertCover({
      compositionId: 'comp-1',
      durationSec: 3,
      frameMediaId: 'media-cover',
      frameSrc: 'blob:cover',
      frameWidth: 1920,
      frameHeight: 1080,
      primary: 'TEKNIK',
      accent: 'JAGO NGOMONG',
    })

    expect(result.coverDurationFrames).toBe(90)

    // Compositions-store must NOT be updated when we're inside the comp —
    // saveCurrentToComposition would overwrite it on exit.
    expect(fakeStore.updateCalls).toHaveLength(0)

    // setTracks called once with the new Cover track appended.
    expect(fakeStore.itemsStore.setTracksCalls).toHaveLength(1)
    const newTracks = fakeStore.itemsStore.setTracksCalls[0]!
    expect(newTracks).toHaveLength(2)
    expect(newTracks.some((t) => t.name === 'Cover')).toBe(true)

    // _moveItems shifts both existing items by 90 frames.
    expect(fakeStore.itemsStore.moveItemsCalls).toHaveLength(1)
    const shifts = fakeStore.itemsStore.moveItemsCalls[0]!
    expect(shifts.find((s) => s.id === 'a')?.from).toBe(90)
    expect(shifts.find((s) => s.id === 'b')?.from).toBe(150)

    // _addItems contains image + 2 text items (primary + accent).
    expect(fakeStore.itemsStore.addItemsCalls).toHaveLength(1)
    const added = fakeStore.itemsStore.addItemsCalls[0]!
    expect(added).toHaveLength(3)
    expect(added.some((i) => i.type === 'image' && i.mediaId === 'media-cover')).toBe(true)
  })
})
