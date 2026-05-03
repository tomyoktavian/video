import { describe, expect, it } from 'vite-plus/test'

import { __test } from './compound-assembly'
import type {
  AssembleSegmentInput,
  AssembleSingleCompoundParams,
  EpisodeAssemblyContext,
} from './compound-assembly'
import type { MediaMetadata } from '@/types/storage'

const { buildSubtitleItemsForSegment, buildItemsForAssembly } = __test

const baseSegment = {
  index: 0,
  sourceStartSec: 0,
  sourceEndSec: 10,
  finalDurationSec: 5,
  narration: 'Pemuda itu tiba di kota.',
}

describe('buildSubtitleItemsForSegment — transcript fallback', () => {
  it('returns [] when narration is empty and no transcript is given', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-1',
      segment: { ...baseSegment, narration: '   ' },
      cursorFrame: 0,
      segmentDurationFrames: 150,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      transcript: undefined,
    })
    expect(items).toEqual([])
  })

  it('emits a single subtitle covering the full segment when transcript is missing', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-1',
      segment: baseSegment,
      cursorFrame: 60,
      segmentDurationFrames: 150,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      transcript: undefined,
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('Pemuda itu tiba di kota.')
    expect(items[0]!.from).toBe(60)
    expect(items[0]!.durationInFrames).toBe(150)
  })
})

describe('buildItemsForAssembly — episode mode', () => {
  const sourceMedia: MediaMetadata = {
    id: 'src-1',
    projectId: 'proj-1',
    fileName: 'film.mp4',
    fileSize: 1,
    mimeType: 'video/mp4',
    duration: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    addedAt: 0,
    opfsPath: 'film.mp4',
  } as unknown as MediaMetadata

  const segments: AssembleSegmentInput[] = [
    {
      index: 0,
      sourceStartSec: 0,
      sourceEndSec: 5,
      finalDurationSec: 5,
      narration: 'Pertama kali kita lihat...',
    },
    {
      index: 1,
      sourceStartSec: 5,
      sourceEndSec: 10,
      finalDurationSec: 5,
      narration: 'Lalu sesuatu terjadi...',
    },
  ]

  const baseParams: Omit<AssembleSingleCompoundParams, 'episode'> = {
    name: 'Test Episode',
    sourceMedia,
    sourceMediaId: 'src-1',
    sourceBlobUrl: 'blob:fake/source',
    sourceThumbnailUrl: null,
    segments,
    ttsResults: [],
    narrationMediaById: new Map(),
    fps: 30,
    canvasWidth: 1920,
    canvasHeight: 1080,
    insertSubtitles: false,
    includeOriginalAudio: true,
  }

  const cover = {
    frameMediaId: 'cover-media-1',
    frameSrc: 'blob:fake/cover',
    frameWidth: 1280,
    frameHeight: 720,
  }

  function buildEpisode(overrides: Partial<EpisodeAssemblyContext>): EpisodeAssemblyContext {
    return {
      episodeIndex: 1,
      episodeTotal: 3,
      parentSpoilerRunId: 'run-1',
      includesOpening: false,
      includesClosing: false,
      openingText: null,
      closingText: null,
      openingNarration: null,
      closingNarration: null,
      cover,
      coverDurationSec: 0,
      narrationSpeed: 1,
      ...overrides,
    }
  }

  const opening = { mediaId: 'tts-open', blobUrl: 'blob:fake/open', durationSec: 2 }
  const closing = { mediaId: 'tts-close', blobUrl: 'blob:fake/close', durationSec: 3 }

  it('episode 1 (closing only) — no opening; closing window plays B-roll video, not blank cover', () => {
    const built = buildItemsForAssembly({
      ...baseParams,
      episode: buildEpisode({
        episodeIndex: 1,
        includesOpening: false,
        includesClosing: true,
        closingText: 'Lanjutkan ke episode 2',
        closingNarration: closing,
      }),
    })

    // Body = 2 segments × 5s × 30fps = 300 frames; closing = 3s × 30fps = 90 frames
    expect(built.totalDurationFrames).toBe(390)
    // Two body segments + one closing B-roll = 3 video items.
    expect(built.videoItems).toHaveLength(3)
    expect(built.videoItems[0]!.from).toBe(0)
    expect(built.videoItems[1]!.from).toBe(150)
    const closingVideo = built.videoItems[2]!
    expect(closingVideo.from).toBe(300)
    expect(closingVideo.durationInFrames).toBe(90)
    expect(closingVideo.mediaId).toBe('src-1')
    // Closing B-roll source range starts where the last segment ended:
    // lastSegment.sourceEndSec = 10s × 30fps = 300 source frames.
    expect(closingVideo.sourceStart).toBe(300)
    // Boundary track exists (closing text overlay).
    expect(built.newTracks.some((t) => t.name === 'Spoiler Boundary')).toBe(true)
    // Closing window has NO cover image — video plays under the text instead.
    expect(built.imageItems).toHaveLength(0)
    // Boundary text at the tail.
    const boundaryText = built.textItems.find((t) => t.text === 'Lanjutkan ke episode 2')
    expect(boundaryText).toBeDefined()
    expect(boundaryText!.from).toBe(300)
    // Closing narration audio.
    expect(built.closingNarrationItemId).not.toBeNull()
    expect(built.openingNarrationItemId).toBeNull()
    const closingAudio = built.audioItems.find((a) => a.mediaId === 'tts-close')
    expect(closingAudio).toBeDefined()
    expect(closingAudio!.from).toBe(300)
  })

  it('middle episode (no preroll) — opening B-roll video at head, closing B-roll at tail', () => {
    const built = buildItemsForAssembly({
      ...baseParams,
      episode: buildEpisode({
        episodeIndex: 2,
        includesOpening: true,
        includesClosing: true,
        openingText: 'Selamat datang di episode 2',
        closingText: 'Lanjutkan ke episode 3',
        openingNarration: opening,
        closingNarration: closing,
        coverDurationSec: 0,
      }),
    })

    // No preroll. Opening = 2s × 30fps = 60. Body = 300. Closing = 90. Total = 450.
    expect(built.totalDurationFrames).toBe(450)
    // Opening B-roll + 2 segments + closing B-roll = 4 video items.
    expect(built.videoItems).toHaveLength(4)
    expect(built.videoItems[0]!.from).toBe(0) // opening B-roll
    expect(built.videoItems[0]!.durationInFrames).toBe(60)
    expect(built.videoItems[1]!.from).toBe(60) // segment 1
    expect(built.videoItems[2]!.from).toBe(210) // segment 2
    expect(built.videoItems[3]!.from).toBe(360) // closing B-roll
    expect(built.videoItems[3]!.durationInFrames).toBe(90)
    // No cover image (cover preroll is 0).
    expect(built.imageItems).toHaveLength(0)
    // Both narration ids set.
    expect(built.openingNarrationItemId).not.toBeNull()
    expect(built.closingNarrationItemId).not.toBeNull()
  })

  it('middle episode (with cover preroll) — cover at head, then B-roll for opening narration', () => {
    const built = buildItemsForAssembly({
      ...baseParams,
      episode: buildEpisode({
        episodeIndex: 2,
        includesOpening: true,
        includesClosing: true,
        openingText: 'Selamat datang di episode 2',
        closingText: 'Lanjutkan ke episode 3',
        openingNarration: opening,
        closingNarration: closing,
        coverDurationSec: 4, // 4s × 30fps = 120 preroll frames
      }),
    })

    // Preroll=120 + Opening=60 + Body=300 + Closing=90 = 570.
    expect(built.totalDurationFrames).toBe(570)
    // Cover image alone in preroll [0, 120).
    expect(built.imageItems).toHaveLength(1)
    expect(built.imageItems[0]!.from).toBe(0)
    expect(built.imageItems[0]!.durationInFrames).toBe(120)
    expect(built.imageItems[0]!.mediaId).toBe('cover-media-1')
    // Opening B-roll at frame 120 (after preroll).
    expect(built.videoItems[0]!.from).toBe(120)
    expect(built.videoItems[0]!.durationInFrames).toBe(60)
    // Body shifted by preroll + opening = 180.
    expect(built.videoItems[1]!.from).toBe(180)
    expect(built.videoItems[2]!.from).toBe(330)
    // Closing B-roll at 480.
    expect(built.videoItems[3]!.from).toBe(480)
  })

  it('boundary narration speed=2 halves opening/closing window length and stamps speed on audio', () => {
    const built = buildItemsForAssembly({
      ...baseParams,
      episode: buildEpisode({
        episodeIndex: 2,
        includesOpening: true,
        includesClosing: true,
        openingText: 'Selamat datang di episode 2',
        closingText: 'Lanjutkan ke episode 3',
        openingNarration: opening,
        closingNarration: closing,
        narrationSpeed: 2,
      }),
    })

    // Opening = round(2/2 × 30) = 30. Closing = round(3/2 × 30) = 45. Body = 300.
    expect(built.totalDurationFrames).toBe(30 + 300 + 45)
    // Opening narration audio carries speed=2 and the timeline duration is half.
    const openingAudio = built.audioItems.find((a) => a.mediaId === 'tts-open')
    expect(openingAudio).toBeDefined()
    expect(openingAudio!.speed).toBe(2)
    expect(openingAudio!.durationInFrames).toBe(30)
    // Closing audio likewise.
    const closingAudio = built.audioItems.find((a) => a.mediaId === 'tts-close')
    expect(closingAudio).toBeDefined()
    expect(closingAudio!.speed).toBe(2)
    expect(closingAudio!.durationInFrames).toBe(45)
  })

  it('last episode — opening B-roll at head, no closing video at tail', () => {
    const built = buildItemsForAssembly({
      ...baseParams,
      episode: buildEpisode({
        episodeIndex: 3,
        includesOpening: true,
        includesClosing: false,
        openingText: 'Selamat datang di episode 3',
        openingNarration: opening,
        coverDurationSec: 0,
      }),
    })

    // Opening = 60, body = 300. Total = 360. No closing.
    expect(built.totalDurationFrames).toBe(360)
    // Opening B-roll + 2 segments = 3 video items.
    expect(built.videoItems).toHaveLength(3)
    expect(built.videoItems[0]!.from).toBe(0) // opening B-roll
    expect(built.videoItems[1]!.from).toBe(60) // segment 1
    expect(built.videoItems[2]!.from).toBe(210) // segment 2
    // No cover image (coverDurationSec = 0).
    expect(built.imageItems).toHaveLength(0)
    expect(built.openingNarrationItemId).not.toBeNull()
    expect(built.closingNarrationItemId).toBeNull()
  })

  it('without cover, closing still has B-roll video + text + audio (no image)', () => {
    const built = buildItemsForAssembly({
      ...baseParams,
      episode: buildEpisode({
        episodeIndex: 1,
        includesOpening: false,
        includesClosing: true,
        closingText: 'Lanjutkan ke episode 2',
        closingNarration: closing,
        cover: null,
      }),
    })
    expect(built.imageItems).toHaveLength(0)
    expect(built.videoItems).toHaveLength(3) // 2 body + 1 closing B-roll
    expect(built.textItems.some((t) => t.text === 'Lanjutkan ke episode 2')).toBe(true)
    expect(built.closingNarrationItemId).not.toBeNull()
  })

  it('non-episode mode (legacy) — no Spoiler Boundary track is created', () => {
    const built = buildItemsForAssembly(baseParams)
    expect(built.newTracks.some((t) => t.name === 'Spoiler Boundary')).toBe(false)
    expect(built.imageItems).toHaveLength(0)
    expect(built.openingNarrationItemId).toBeNull()
    expect(built.closingNarrationItemId).toBeNull()
  })
})

describe('buildSubtitleItemsForSegment — word-level transcript', () => {
  const transcript = [
    {
      text: 'Hello world friend.',
      start: 0,
      end: 1.5,
      words: [
        { text: 'Hello', start: 0, end: 0.5 },
        { text: 'world', start: 0.5, end: 1.0 },
        { text: 'friend.', start: 1.0, end: 1.5 },
      ],
    },
  ]

  it('groups short narration into a single phrase chunk', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-sub',
      segment: { ...baseSegment, narration: 'Hello world friend.' },
      cursorFrame: 100,
      segmentDurationFrames: 60,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      transcript,
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe('Hello world friend.')
    expect(items[0]!.from).toBe(100)
  })

  it('uses shadow-only styling — transparent background + textShadow', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-sub',
      segment: { ...baseSegment, narration: 'Hello world friend.' },
      cursorFrame: 0,
      segmentDurationFrames: 60,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      transcript,
    })
    const first = items[0]!
    expect(first.backgroundColor).toBe('transparent')
    expect(first.textShadow).toEqual({
      offsetX: 0,
      offsetY: 2,
      blur: 8,
      color: 'rgba(0, 0, 0, 0.85)',
    })
    expect(first.color).toBe('#ffffff')
  })

  it('clamps subtitle items inside the segment frame window', () => {
    const items = buildSubtitleItemsForSegment({
      trackId: 'track-sub',
      segment: { ...baseSegment, narration: 'Hello world friend.' },
      cursorFrame: 100,
      // Segment shorter than transcript span (1.5 s = 45 frames @ 30 fps).
      segmentDurationFrames: 30,
      fps: 30,
      canvasWidth: 1080,
      canvasHeight: 1920,
      transcript,
    })
    for (const item of items) {
      expect(item.from).toBeGreaterThanOrEqual(100)
      expect(item.from + item.durationInFrames).toBeLessThanOrEqual(130)
    }
  })
})
