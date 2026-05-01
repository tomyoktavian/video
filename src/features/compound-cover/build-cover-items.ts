/**
 * Vlog-style cover template — turns a chosen frame and three text slots into:
 *
 *   - 1 ImageItem covering the full canvas (the picked frame)
 *   - 1-3 TextItems on top of it (primary / accent / secondary)
 *
 * All items share the same `from = 0` and `durationInFrames = coverDuration`,
 * placed on a fresh "Cover" track at the top of the SubComposition.
 *
 * The result is plain timeline data — once inserted, the user can edit each
 * piece (font, colour, position) like any other clip. The only thing that
 * makes a cover a "cover" is its position at frame 0 of the compound clip.
 */

import type { ImageItem, TextItem, TimelineTrack } from '@/types/timeline'

// ---------------------------------------------------------------------------
// Vlog template constants
// ---------------------------------------------------------------------------

/** Yellow highlight chip (matches the screenshot the user provided). */
const ACCENT_HIGHLIGHT_BACKGROUND = '#facc15'
/** Red accent text (matches the JAGO NGOMONG screenshot). */
const PRIMARY_ACCENT_COLOR = '#ef4444'
const TEXT_COLOR = '#ffffff'
const TEXT_SHADOW = {
  offsetX: 0,
  offsetY: 4,
  blur: 12,
  color: 'rgba(0, 0, 0, 0.85)',
}

// Layout — fractions of canvasHeight unless noted.
const PRIMARY_FONT_SIZE_RATIO = 0.13
const ACCENT_FONT_SIZE_RATIO = 0.13
const SECONDARY_FONT_SIZE_RATIO = 0.07

// Vertical placement (positive = down, negative = up; canvas-centre origin
// per `resolveTransform` convention used elsewhere in the codebase).
const PRIMARY_Y_RATIO = -0.28
const ACCENT_Y_RATIO = -0.1
const SECONDARY_Y_RATIO = 0.12

// Horizontal layout — covers fill ~85% of canvas width to keep margin.
const TEXT_BOX_WIDTH_RATIO = 0.85
const TEXT_BOX_HEIGHT_RATIO = 0.16

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildCoverItemsOptions {
  /** Track id the new items get assigned to (a fresh "Cover" track). */
  trackId: string
  /** Total cover duration in frames (project-FPS of the SubComposition). */
  durationInFrames: number
  /** Resolved Media Library id for the chosen frame (used by ImageItem.mediaId). */
  frameMediaId: string
  /** Blob URL or any URL the renderer can load for the frame image. */
  frameSrc: string
  /** Intrinsic frame size (used for ImageItem.sourceWidth/Height). */
  frameWidth: number
  frameHeight: number
  /** Canvas size of the SubComposition. */
  canvasWidth: number
  canvasHeight: number
  /** Title text slots. `primary` is required; the other two may be empty. */
  primary: string
  accent?: string
  secondary?: string
}

export interface BuildCoverItemsResult {
  image: ImageItem
  texts: TextItem[]
}

export function buildCoverItems(options: BuildCoverItemsOptions): BuildCoverItemsResult {
  const {
    trackId,
    durationInFrames,
    frameMediaId,
    frameSrc,
    frameWidth,
    frameHeight,
    canvasWidth,
    canvasHeight,
    primary,
    accent,
    secondary,
  } = options

  const safeDuration = Math.max(1, Math.round(durationInFrames))
  const baseFields = {
    trackId,
    from: 0,
    durationInFrames: safeDuration,
  }

  const image: ImageItem = {
    ...baseFields,
    id: crypto.randomUUID(),
    type: 'image',
    label: 'Cover Frame',
    mediaId: frameMediaId,
    src: frameSrc,
    sourceWidth: frameWidth,
    sourceHeight: frameHeight,
    transform: {
      x: 0,
      y: 0,
      width: canvasWidth,
      height: canvasHeight,
      rotation: 0,
      opacity: 1,
    },
  }

  const texts: TextItem[] = []
  const trimmedPrimary = primary.trim()
  const trimmedAccent = (accent ?? '').trim()
  const trimmedSecondary = (secondary ?? '').trim()

  if (trimmedPrimary.length > 0) {
    texts.push(
      buildVlogTextItem({
        baseFields,
        text: trimmedPrimary,
        canvasWidth,
        canvasHeight,
        fontSizeRatio: PRIMARY_FONT_SIZE_RATIO,
        yRatio: PRIMARY_Y_RATIO,
        color: TEXT_COLOR,
        labelPrefix: 'Cover Title',
      }),
    )
  }

  if (trimmedAccent.length > 0) {
    texts.push(
      buildVlogTextItem({
        baseFields,
        text: trimmedAccent,
        canvasWidth,
        canvasHeight,
        fontSizeRatio: ACCENT_FONT_SIZE_RATIO,
        yRatio: ACCENT_Y_RATIO,
        color: PRIMARY_ACCENT_COLOR,
        labelPrefix: 'Cover Accent',
      }),
    )
  }

  if (trimmedSecondary.length > 0) {
    texts.push(
      buildVlogTextItem({
        baseFields,
        text: trimmedSecondary,
        canvasWidth,
        canvasHeight,
        fontSizeRatio: SECONDARY_FONT_SIZE_RATIO,
        yRatio: SECONDARY_Y_RATIO,
        color: '#0f172a',
        backgroundColor: ACCENT_HIGHLIGHT_BACKGROUND,
        labelPrefix: 'Cover Subtitle',
      }),
    )
  }

  return { image, texts }
}

interface BuildVlogTextItemArgs {
  baseFields: { trackId: string; from: number; durationInFrames: number }
  text: string
  canvasWidth: number
  canvasHeight: number
  fontSizeRatio: number
  yRatio: number
  color: string
  backgroundColor?: string
  labelPrefix: string
}

function buildVlogTextItem(args: BuildVlogTextItemArgs): TextItem {
  const fontSize = Math.max(28, Math.round(args.canvasHeight * args.fontSizeRatio))
  return {
    ...args.baseFields,
    id: crypto.randomUUID(),
    type: 'text',
    label: `${args.labelPrefix}: ${args.text.slice(0, 40)}`,
    text: args.text.toUpperCase(),
    fontSize,
    fontFamily: 'Inter',
    fontWeight: 'bold',
    fontStyle: 'normal',
    underline: false,
    color: args.color,
    ...(args.backgroundColor ? { backgroundColor: args.backgroundColor } : {}),
    backgroundRadius: args.backgroundColor ? 6 : 0,
    textAlign: 'center',
    verticalAlign: 'middle',
    lineHeight: 1.05,
    letterSpacing: 0,
    textShadow: TEXT_SHADOW,
    transform: {
      x: 0,
      y: Math.round(args.canvasHeight * args.yRatio),
      width: args.canvasWidth * TEXT_BOX_WIDTH_RATIO,
      height: args.canvasHeight * TEXT_BOX_HEIGHT_RATIO,
      rotation: 0,
      opacity: 1,
    },
  }
}

/**
 * Build a fresh "Cover" track positioned visually above every existing track
 * in the SubComposition (lower `order` = higher on screen by codebase
 * convention).
 */
export function buildCoverTrack(existingTracks: readonly TimelineTrack[]): TimelineTrack {
  const minOrder = existingTracks.reduce(
    (min, track) => Math.min(min, track.order),
    Number.POSITIVE_INFINITY,
  )
  const nextOrder = existingTracks.length === 0 ? 0 : minOrder - 1
  return {
    id: `track-cover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: 'Cover',
    kind: 'video',
    height: 40,
    locked: false,
    syncLock: false,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    order: nextOrder,
    items: [],
  }
}
