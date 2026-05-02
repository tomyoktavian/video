/**
 * Types shared across the Highlight Finder feature.
 *
 * Source-time vs timeline-time:
 * - `sourceStartSec`/`sourceEndSec` are in source-media seconds (anchored to
 *   the underlying file). The chat model receives times in this domain.
 * - `timelineStartFrame`/`timelineEndFrame` are in project-FPS frames
 *   (anchored to the active timeline). The mutation phase converts between
 *   them using each fragment's recorded mapping.
 */

import type { MediaCaption } from '@/infrastructure/analysis'

export interface TranscriptWordLite {
  text: string
  /** Source-media seconds. */
  start: number
  /** Source-media seconds. */
  end: number
}

export interface TranscriptSegmentLite {
  text: string
  start: number
  end: number
  /**
   * Word-level timing when the source transcript exposes it. Used by the
   * subtitle splitter to time individual phrase chunks. Absent on legacy
   * transcripts and providers like `gpt-4o-transcribe` that omit timestamps.
   */
  words?: readonly TranscriptWordLite[]
}

export interface HighlightFinderClipContext {
  itemId: string
  mediaId: string
  mediaFileName: string
  /** Inclusive start in source-media seconds. */
  sourceStartSec: number
  /** Exclusive end in source-media seconds. */
  sourceEndSec: number
  /** Start frame in project-FPS (timeline domain). */
  timelineStartFrame: number
  /** End frame in project-FPS (timeline domain), exclusive. */
  timelineEndFrame: number
  /** Project frames per second. */
  fps: number
  /** Source-media frames per second (used to convert source-time → project frames). */
  sourceFps: number
  captions: readonly MediaCaption[]
  transcriptSegments: readonly TranscriptSegmentLite[]
}

export interface HighlightFinderRequest {
  clips: readonly HighlightFinderClipContext[]
  targetCount: number
  clipDurationSec: number
  /** Optional override for the system prompt. Empty string = use default. */
  systemPromptOverride?: string
  /**
   * ISO-639-1 code (e.g. `'id'`, `'en'`) requesting that the AI write the
   * `title` field in this language regardless of the source content. Empty
   * string or `'auto'` = match the source language.
   */
  titleLanguage?: string
  signal?: AbortSignal
}

export interface AiHighlight {
  mediaId: string
  startTimeSec: number
  endTimeSec: number
  title?: string
  rationale?: string
  /** AI-suggested visual vibe for the title card: 'clean' | 'bold' | 'energetic' | 'cinematic' | 'modern' */
  titleStyle?: string
}

export interface ResolvedHighlightPlan {
  /** Timeline item id whose fragment will be split + wrapped. */
  itemId: string
  /** [splitStartFrame, splitEndFrame] in project-FPS (timeline domain). */
  splitFrames: [number, number]
  /** Display label for the resulting compound clip. */
  title: string
  /** Source media id — used to match against clip contexts for text generation. */
  mediaId: string
  /** Highlight start in source-media seconds. */
  sourceStartSec: number
  /** Highlight end in source-media seconds. */
  sourceEndSec: number
  /** Project FPS at the time of resolution. */
  fps: number
  /** AI-suggested visual vibe forwarded to the title card preset picker. */
  titleStyle?: string
}
