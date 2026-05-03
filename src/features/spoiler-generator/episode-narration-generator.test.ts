import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('./deps/tts', () => ({
  customTtsService: {
    generateSpeechFile: vi.fn(async ({ text }: { text: string }) => ({
      blob: new Blob([text], { type: 'audio/mp3' }),
      file: new File([text], 'tts.mp3', { type: 'audio/mp3' }),
      duration: 2.5,
    })),
  },
}))

vi.mock('./deps/media-library', () => ({
  mediaLibraryService: {
    importGeneratedAudio: vi.fn(async (file: File) => ({
      id: `media-${file.name}-${Math.random().toString(36).slice(2, 8)}`,
    })),
    getMediaBlobUrl: vi.fn(async (id: string) => `blob:fake/${id}`),
  },
}))

import { generateEpisodeNarrations, substituteTemplate } from './episode-narration-generator'
import type { EpisodeBucket } from './episode-planner'

describe('substituteTemplate', () => {
  it('substitutes {n} only', () => {
    expect(substituteTemplate('Selamat datang di episode {n}', { n: 2, next: 3 })).toBe(
      'Selamat datang di episode 2',
    )
  })

  it('substitutes {next} only', () => {
    expect(substituteTemplate('Lanjutkan ke episode {next}', { n: 2, next: 3 })).toBe(
      'Lanjutkan ke episode 3',
    )
  })

  it('substitutes both placeholders', () => {
    expect(substituteTemplate('Episode {n} berakhir, lanjutkan ke {next}', { n: 1, next: 2 })).toBe(
      'Episode 1 berakhir, lanjutkan ke 2',
    )
  })

  it('leaves text without placeholders untouched', () => {
    expect(substituteTemplate('Halo dunia', { n: 5, next: 6 })).toBe('Halo dunia')
  })

  it('leaves unknown placeholders unchanged', () => {
    expect(substituteTemplate('Episode {title}', { n: 1, next: 2 })).toBe('Episode {title}')
  })
})

describe('generateEpisodeNarrations', () => {
  const baseInput = {
    openingTemplate: 'Selamat datang di episode {n}',
    closingTemplate: 'Lanjutkan nonton di episode {next}',
    projectId: 'proj-1',
  }

  it('returns no lines when episodes count is 1 (no opening, no closing)', async () => {
    const episodes: EpisodeBucket[] = [
      {
        episodeIndex: 1,
        segmentIndices: [0, 1],
        includesOpening: false,
        includesClosing: false,
        estimatedBodyDurationSec: 90,
      },
    ]
    const lines = await generateEpisodeNarrations({ ...baseInput, episodes })
    expect(lines).toHaveLength(0)
  })

  it('produces 2*(N-1) lines for N episodes', async () => {
    const episodes: EpisodeBucket[] = [
      {
        episodeIndex: 1,
        segmentIndices: [0],
        includesOpening: false,
        includesClosing: true,
        estimatedBodyDurationSec: 90,
      },
      {
        episodeIndex: 2,
        segmentIndices: [1],
        includesOpening: true,
        includesClosing: true,
        estimatedBodyDurationSec: 90,
      },
      {
        episodeIndex: 3,
        segmentIndices: [2],
        includesOpening: true,
        includesClosing: true,
        estimatedBodyDurationSec: 90,
      },
      {
        episodeIndex: 4,
        segmentIndices: [3],
        includesOpening: true,
        includesClosing: false,
        estimatedBodyDurationSec: 90,
      },
    ]
    const lines = await generateEpisodeNarrations({ ...baseInput, episodes })
    expect(lines).toHaveLength(6) // 3 openings + 3 closings
    const openings = lines.filter((l) => l.kind === 'opening')
    const closings = lines.filter((l) => l.kind === 'closing')
    expect(openings).toHaveLength(3)
    expect(closings).toHaveLength(3)
    expect(openings.map((l) => l.episodeIndex)).toEqual([2, 3, 4])
    expect(closings.map((l) => l.episodeIndex)).toEqual([1, 2, 3])
  })

  it('substitutes templates correctly per episode', async () => {
    const episodes: EpisodeBucket[] = [
      {
        episodeIndex: 1,
        segmentIndices: [0],
        includesOpening: false,
        includesClosing: true,
        estimatedBodyDurationSec: 90,
      },
      {
        episodeIndex: 2,
        segmentIndices: [1],
        includesOpening: true,
        includesClosing: false,
        estimatedBodyDurationSec: 90,
      },
    ]
    const lines = await generateEpisodeNarrations({ ...baseInput, episodes })
    expect(lines).toHaveLength(2)
    const closing1 = lines.find((l) => l.kind === 'closing' && l.episodeIndex === 1)!
    const opening2 = lines.find((l) => l.kind === 'opening' && l.episodeIndex === 2)!
    expect(closing1.text).toBe('Lanjutkan nonton di episode 2')
    expect(opening2.text).toBe('Selamat datang di episode 2')
  })

  it('reports progress with completed/total counts', async () => {
    const episodes: EpisodeBucket[] = [
      {
        episodeIndex: 1,
        segmentIndices: [0],
        includesOpening: false,
        includesClosing: true,
        estimatedBodyDurationSec: 90,
      },
      {
        episodeIndex: 2,
        segmentIndices: [1],
        includesOpening: true,
        includesClosing: false,
        estimatedBodyDurationSec: 90,
      },
    ]
    const calls: Array<[number, number]> = []
    await generateEpisodeNarrations({
      ...baseInput,
      episodes,
      onProgress: (current, total) => calls.push([current, total]),
    })
    expect(calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })
})
