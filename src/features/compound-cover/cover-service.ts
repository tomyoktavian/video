/**
 * Orchestration for Add Cover.
 *
 * Two responsibilities the dialog calls into:
 *
 *   - {@link gatherCompositionTranscript} — concatenates the transcripts of
 *     every video/audio item inside the compound clip into one string for
 *     the AI to read.
 *   - {@link generateCoverText} — calls the cover-text adapter with either
 *     the gathered transcript or a free-form user prompt.
 */

import { createLogger } from '@/shared/logging/logger'

import { getCustomAiVisionAnalyzerConfig } from './deps/settings'
import { findCoverText, summariseTranscriptForCover } from './openai-compatible-cover-adapter'
import {
  buildPosterImagePrompt,
  type PosterCastValue,
  type PosterMoodValue,
  type PosterStyleValue,
} from './system-prompt'
import { getTranscript, useCompositionsStore } from './deps/timeline'
import type { CoverTextResponse } from './types'

const logger = createLogger('CompoundCover:Service')

const TRANSCRIPT_BUDGET_CHARS = 50_000

/**
 * Walk the SubComposition's items, gather all media IDs that have a transcript
 * on disk, and join their transcripts into a single newline-separated string.
 * Returns an empty string when the comp has no transcribed media — callers
 * should fall through to the manual-prompt path.
 */
export async function gatherCompositionTranscript(compositionId: string): Promise<string> {
  const composition = useCompositionsStore.getState().getComposition(compositionId)
  if (!composition) return ''

  const mediaIds = new Set<string>()
  for (const item of composition.items) {
    if ((item.type === 'video' || item.type === 'audio') && item.mediaId) {
      mediaIds.add(item.mediaId)
    }
  }
  if (mediaIds.size === 0) return ''

  const buckets: string[] = []
  let totalChars = 0
  for (const mediaId of mediaIds) {
    try {
      const transcript = await getTranscript(mediaId)
      if (!transcript || transcript.segments.length === 0) continue
      const text = transcript.segments
        .map((seg) => seg.text.trim())
        .filter(Boolean)
        .join(' ')
        .trim()
      if (text.length === 0) continue
      buckets.push(text)
      totalChars += text.length + 1
      if (totalChars > TRANSCRIPT_BUDGET_CHARS) break
    } catch (error) {
      logger.warn(`getTranscript(${mediaId}) failed while gathering cover context`, error)
    }
  }

  return buckets.join('\n').slice(0, TRANSCRIPT_BUDGET_CHARS).trim()
}

export interface GenerateCoverTextParams {
  mode: 'transcript' | 'manual-prompt'
  /**
   * For `transcript` mode: the SubComposition id. The service gathers the
   * combined transcript itself.
   *
   * For `manual-prompt` mode: ignored.
   */
  compositionId?: string
  /** For `manual-prompt` mode: the user-typed brief. */
  prompt?: string
  signal?: AbortSignal
}

export async function generateCoverText(
  params: GenerateCoverTextParams,
): Promise<CoverTextResponse> {
  let context = ''
  if (params.mode === 'transcript') {
    if (!params.compositionId) {
      throw new Error('compositionId is required when mode is "transcript".')
    }
    context = await gatherCompositionTranscript(params.compositionId)
    if (context.length === 0) {
      throw new Error(
        'No transcript found in this compound clip. Generate a transcript on at least one of its clips first, or switch to Manual prompt.',
      )
    }
  } else {
    context = (params.prompt ?? '').trim()
    if (context.length === 0) {
      throw new Error('Type a context prompt to generate cover text.')
    }
  }

  return findCoverText({
    mode: params.mode,
    context,
    ...(params.signal ? { signal: params.signal } : {}),
  })
}

function gcdInt(a: number, b: number): number {
  let x = Math.max(1, Math.round(a))
  let y = Math.max(1, Math.round(b))
  while (y !== 0) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

/**
 * Resolves a human-readable aspect-ratio label for the compound's dimensions.
 * Snaps to the canonical 16:9, 9:16, 1:1, 4:3, 3:4 buckets when within ~5%
 * of those ratios so the chat model gets a familiar token; otherwise reduces
 * `(width, height)` to lowest terms.
 */
function resolveAspectLabel(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1:1'
  }
  const ratio = width / height
  if (Math.abs(ratio - 1) < 0.05) return '1:1'
  if (Math.abs(ratio - 16 / 9) < 0.05) return '16:9'
  if (Math.abs(ratio - 9 / 16) < 0.05) return '9:16'
  if (Math.abs(ratio - 4 / 3) < 0.05) return '4:3'
  if (Math.abs(ratio - 3 / 4) < 0.05) return '3:4'
  const w = Math.round(width)
  const h = Math.round(height)
  const d = gcdInt(w, h)
  return `${w / d}:${h / d}`
}

export interface CoverFormDefaults {
  title: string
  transcript: string
  aspectLabel: string
  /** Canvas width in pixels — used by the dialog to pre-select the aspect-ratio dropdown. */
  width: number
  /** Canvas height in pixels — used by the dialog to pre-select the aspect-ratio dropdown. */
  height: number
}

/**
 * Pull the initial values for the Add Cover → Generate with AI form: the
 * compound's name as title, every video/audio transcript joined together,
 * the canvas-derived aspect-ratio label, and the raw canvas dimensions
 * (so the form can pre-select the matching aspect-ratio option). The
 * dialog uses this on open to populate the form fields.
 */
export async function gatherCoverFormDefaults(compositionId: string): Promise<CoverFormDefaults> {
  const composition = useCompositionsStore.getState().getComposition(compositionId)
  if (!composition) {
    throw new Error('Composition not found.')
  }
  const transcript = await gatherCompositionTranscript(compositionId)
  const title = composition.name?.trim() ?? ''
  return {
    title,
    transcript,
    aspectLabel: resolveAspectLabel(composition.width, composition.height),
    width: composition.width,
    height: composition.height,
  }
}

export interface BuildCoverImagePromptFromFormParams {
  title: string
  transcript: string
  aspectLabel: string
  cast?: PosterCastValue
  style?: PosterStyleValue
  mood?: PosterMoodValue
  customNotes?: string
}

/**
 * Compile the final image-generation prompt from the AI form's field
 * values. Pure / synchronous — no HTTP calls. The optional Settings →
 * Vision Analyzer → Poster Prompt template override is honoured here so
 * advanced users can rewrite the skeleton while still using the form
 * fields as the data source.
 */
export function buildCoverImagePromptFromForm(params: BuildCoverImagePromptFromFormParams): string {
  const title = params.title.trim()
  const transcript = params.transcript.trim()
  if (title.length === 0 && transcript.length === 0) {
    throw new Error('Provide a title or a transcript before generating the cover image.')
  }
  const templateOverride = getCustomAiVisionAnalyzerConfig().posterPromptSystemPrompt
  return buildPosterImagePrompt({
    title,
    transcript,
    aspectLabel: params.aspectLabel,
    ...(params.cast ? { cast: params.cast } : {}),
    ...(params.style ? { style: params.style } : {}),
    ...(params.mood ? { mood: params.mood } : {}),
    ...(params.customNotes ? { customNotes: params.customNotes } : {}),
    templateOverride,
  })
}

export interface SummariseCoverTranscriptParams {
  transcript: string
  signal?: AbortSignal
}

/**
 * Summarise the transcript field via the Vision Analyzer chat-completions
 * provider. The result replaces the transcript field in the form so the
 * subsequent image prompt is shorter and more focused on the story arc.
 */
export async function summariseCoverTranscript(
  params: SummariseCoverTranscriptParams,
): Promise<string> {
  const transcript = params.transcript.trim()
  if (transcript.length === 0) {
    throw new Error('Cannot summarise an empty transcript.')
  }
  return summariseTranscriptForCover({
    transcript,
    ...(params.signal ? { signal: params.signal } : {}),
  })
}
