import { describe, expect, it } from 'vite-plus/test'
import type { TimelineTrack } from '@/types/timeline'

import { buildCoverItems, buildCoverTrack } from './build-cover-items'

const CANVAS = { width: 1920, height: 1080 }

describe('buildCoverItems', () => {
  it('builds an image item that fills the canvas plus three text items', () => {
    const result = buildCoverItems({
      trackId: 'track-cover',
      durationInFrames: 90,
      frameMediaId: 'media-cover',
      frameSrc: 'blob:cover',
      frameWidth: 1920,
      frameHeight: 1080,
      canvasWidth: CANVAS.width,
      canvasHeight: CANVAS.height,
      primary: 'TEKNIK',
      accent: 'JAGO NGOMONG',
      secondary: 'YANG MENGUBAH HIDUP',
    })

    expect(result.image.type).toBe('image')
    expect(result.image.from).toBe(0)
    expect(result.image.durationInFrames).toBe(90)
    expect(result.image.transform).toMatchObject({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      opacity: 1,
    })
    expect(result.image.mediaId).toBe('media-cover')
    expect(result.image.src).toBe('blob:cover')

    expect(result.texts).toHaveLength(3)
    const [primary, accent, secondary] = result.texts
    expect(primary?.text).toBe('TEKNIK')
    expect(accent?.text).toBe('JAGO NGOMONG')
    expect(secondary?.text).toBe('YANG MENGUBAH HIDUP')

    // Primary sits above accent which sits above secondary on canvas
    // (negative y = up; positive y = down per canvas-centre origin convention).
    expect(primary!.transform!.y).toBeLessThan(accent!.transform!.y!)
    expect(accent!.transform!.y).toBeLessThan(secondary!.transform!.y!)

    // Font sizes scale with canvas height.
    expect(primary?.fontSize).toBeGreaterThan(secondary!.fontSize!)
  })

  it('omits empty accent and secondary slots', () => {
    const result = buildCoverItems({
      trackId: 'track-cover',
      durationInFrames: 60,
      frameMediaId: 'media-cover',
      frameSrc: 'blob:cover',
      frameWidth: 1280,
      frameHeight: 720,
      canvasWidth: 1280,
      canvasHeight: 720,
      primary: 'HOOK',
      accent: '',
      secondary: '',
    })

    expect(result.texts).toHaveLength(1)
    expect(result.texts[0]?.text).toBe('HOOK')
  })

  it('clamps duration to at least 1 frame', () => {
    const result = buildCoverItems({
      trackId: 'track-cover',
      durationInFrames: 0,
      frameMediaId: 'media-cover',
      frameSrc: 'blob:cover',
      frameWidth: 100,
      frameHeight: 100,
      canvasWidth: 1920,
      canvasHeight: 1080,
      primary: 'X',
    })
    expect(result.image.durationInFrames).toBe(1)
    expect(result.texts[0]?.durationInFrames).toBe(1)
  })

  it('upper-cases text content for the Vlog template look', () => {
    const result = buildCoverItems({
      trackId: 'track-cover',
      durationInFrames: 90,
      frameMediaId: 'media-cover',
      frameSrc: 'blob:cover',
      frameWidth: 1920,
      frameHeight: 1080,
      canvasWidth: 1920,
      canvasHeight: 1080,
      primary: 'teknik',
      accent: 'jago ngomong',
    })

    expect(result.texts[0]?.text).toBe('TEKNIK')
    expect(result.texts[1]?.text).toBe('JAGO NGOMONG')
  })
})

describe('buildCoverTrack', () => {
  function makeTrack(id: string, order: number): TimelineTrack {
    return {
      id,
      name: id,
      height: 40,
      locked: false,
      visible: true,
      muted: false,
      solo: false,
      order,
      items: [],
    }
  }

  it('places the cover track above all existing tracks', () => {
    const tracks = [makeTrack('a', 0), makeTrack('b', 1), makeTrack('c', 2)]
    const cover = buildCoverTrack(tracks)
    expect(cover.order).toBe(-1)
    expect(cover.kind).toBe('video')
    expect(cover.name).toBe('Cover')
  })

  it('uses order 0 when there are no existing tracks', () => {
    const cover = buildCoverTrack([])
    expect(cover.order).toBe(0)
  })
})
