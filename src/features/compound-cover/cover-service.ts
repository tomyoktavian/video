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

import { findCoverText } from './openai-compatible-cover-adapter'
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
