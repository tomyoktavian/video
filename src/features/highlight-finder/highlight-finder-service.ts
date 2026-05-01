/**
 * Orchestration for the Highlight Finder feature.
 *
 *   selectedItemIds → gather context (captions + transcripts) →
 *   chat-completions reasoning → resolve back to ResolvedHighlightPlan[].
 *
 * The timeline mutation is delegated to `applyHighlightPlans` in
 * `src/features/timeline/stores/actions/highlight-actions.ts` — the dialog
 * calls that after it inspects the plans here.
 */

import { useTimelineStore } from './deps/timeline'
import { useMediaLibraryStore } from './deps/media-library'
import { getCaptions, getTranscript } from '@/infrastructure/storage'
import { createLogger } from '@/shared/logging/logger'

import { findHighlights } from './openai-compatible-highlight-adapter'
import type {
  AiHighlight,
  HighlightFinderClipContext,
  ResolvedHighlightPlan,
  TranscriptSegmentLite,
} from './types'

const logger = createLogger('HighlightFinderService')

const MIN_HIGHLIGHT_DURATION_SEC = 0.5

export interface PrepareHighlightsParams {
  selectedItemIds: readonly string[]
  targetCount: number
  clipDurationSec: number
  /**
   * ISO-639-1 code (e.g. `'id'`, `'en'`) requesting the AI write the
   * `title` field in this language regardless of the source. `'auto'`,
   * `''`, or omitted = match source language.
   */
  titleLanguage?: string
  signal?: AbortSignal
}

export interface PreparedHighlights {
  plans: readonly ResolvedHighlightPlan[]
  contexts: readonly HighlightFinderClipContext[]
  returnedHighlights: number
  skippedHighlights: number
  skippedComps: number
}

async function buildClipContexts(
  selectedItemIds: readonly string[],
): Promise<{ contexts: HighlightFinderClipContext[]; skippedComps: number }> {
  const items = useTimelineStore.getState().items
  const fps = useTimelineStore.getState().fps
  const mediaById = useMediaLibraryStore.getState().mediaById

  let skippedComps = 0
  const contexts: HighlightFinderClipContext[] = []
  const captionCache = new Map<string, Awaited<ReturnType<typeof getCaptions>>>()
  const transcriptCache = new Map<string, Awaited<ReturnType<typeof getTranscript>>>()

  for (const id of selectedItemIds) {
    const item = items.find((entry) => entry.id === id)
    if (!item) continue
    if (item.type === 'composition') {
      skippedComps += 1
      continue
    }
    if (item.type !== 'video' && item.type !== 'audio') continue
    if (!item.mediaId) continue
    const media = mediaById[item.mediaId]
    if (!media) continue

    const sourceFps = item.sourceFps ?? media.fps ?? fps
    if (sourceFps <= 0) continue
    const sourceStart = item.sourceStart ?? 0
    const sourceEnd =
      item.sourceEnd ?? sourceStart + Math.round(item.durationInFrames * (sourceFps / fps))
    const sourceStartSec = sourceStart / sourceFps
    const sourceEndSec = sourceEnd / sourceFps

    if (!captionCache.has(item.mediaId)) {
      try {
        captionCache.set(item.mediaId, await getCaptions(item.mediaId))
      } catch {
        captionCache.set(item.mediaId, undefined)
      }
    }
    if (!transcriptCache.has(item.mediaId)) {
      try {
        transcriptCache.set(item.mediaId, await getTranscript(item.mediaId))
      } catch {
        transcriptCache.set(item.mediaId, undefined)
      }
    }

    const allCaptions = captionCache.get(item.mediaId) ?? []
    const allTranscript = transcriptCache.get(item.mediaId)?.segments ?? []

    const captions = allCaptions.filter(
      (caption) => caption.timeSec >= sourceStartSec && caption.timeSec <= sourceEndSec,
    )
    const transcriptSegments: TranscriptSegmentLite[] = allTranscript
      .filter((seg) => seg.end >= sourceStartSec && seg.start <= sourceEndSec)
      .map((seg) => ({
        text: seg.text,
        start: Math.max(seg.start, sourceStartSec),
        end: Math.min(seg.end, sourceEndSec),
      }))

    contexts.push({
      itemId: item.id,
      mediaId: item.mediaId,
      mediaFileName: media.fileName,
      sourceStartSec,
      sourceEndSec,
      timelineStartFrame: item.from,
      timelineEndFrame: item.from + item.durationInFrames,
      fps,
      sourceFps,
      captions,
      transcriptSegments,
    })
  }

  return { contexts, skippedComps }
}

function pickBestFragmentForHighlight(
  highlight: AiHighlight,
  fragments: readonly HighlightFinderClipContext[],
): HighlightFinderClipContext | null {
  if (fragments.length === 0) return null

  // Prefer exact mediaId match; fall back to all fragments when the model
  // returned a wrong/mangled ID (common with smaller models).
  const byId = fragments.filter((f) => f.mediaId === highlight.mediaId)
  const candidates = byId.length > 0 ? byId : [...fragments]

  if (candidates.length === 1) return candidates[0]!

  // Pick the fragment with the greatest time overlap.
  let best: HighlightFinderClipContext | null = null
  let bestOverlap = -Infinity
  for (const fragment of candidates) {
    const overlapStart = Math.max(fragment.sourceStartSec, highlight.startTimeSec)
    const overlapEnd = Math.min(fragment.sourceEndSec, highlight.endTimeSec)
    const overlap = overlapEnd - overlapStart
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = fragment
    }
  }
  // If no time overlap at all, return the first candidate as last resort.
  return best ?? candidates[0] ?? null
}

function resolveHighlights(
  highlights: readonly AiHighlight[],
  fragments: readonly HighlightFinderClipContext[],
): { plans: ResolvedHighlightPlan[]; skipped: number } {
  const plans: ResolvedHighlightPlan[] = []
  let skipped = 0

  highlights.forEach((highlight, index) => {
    const fragment = pickBestFragmentForHighlight(highlight, fragments)
    if (!fragment) {
      logger.warn('Highlight skipped: no matching fragment', { mediaId: highlight.mediaId, index })
      skipped += 1
      return
    }

    const startSec = Math.max(highlight.startTimeSec, fragment.sourceStartSec)
    const endSec = Math.min(highlight.endTimeSec, fragment.sourceEndSec)
    if (endSec - startSec < MIN_HIGHLIGHT_DURATION_SEC) {
      logger.warn('Highlight skipped: duration too short after clamping', {
        startSec,
        endSec,
        sourceStartSec: fragment.sourceStartSec,
        sourceEndSec: fragment.sourceEndSec,
        index,
      })
      skipped += 1
      return
    }

    // sourceStart in source-FPS frames maps to timelineStartFrame.
    // Convert source-time offset to project-FPS frame offset.
    const offsetSec = startSec - fragment.sourceStartSec
    const durationSec = endSec - startSec
    const startFrame = fragment.timelineStartFrame + Math.round(offsetSec * fragment.fps)
    const endFrame = startFrame + Math.round(durationSec * fragment.fps)

    // splitItemAtFrames refuses splits at item boundaries — keep us strictly inside.
    const safeStart = Math.max(fragment.timelineStartFrame + 1, startFrame)
    const safeEnd = Math.min(fragment.timelineEndFrame - 1, endFrame)
    if (safeEnd - safeStart < 1) {
      logger.warn('Highlight skipped: frame range collapsed after boundary clamping', {
        safeStart,
        safeEnd,
        timelineStartFrame: fragment.timelineStartFrame,
        timelineEndFrame: fragment.timelineEndFrame,
        index,
      })
      skipped += 1
      return
    }

    plans.push({
      itemId: fragment.itemId,
      splitFrames: [safeStart, safeEnd],
      title: highlight.title?.trim() || `Highlight ${index + 1}`,
      mediaId: fragment.mediaId,
      sourceStartSec: startSec,
      sourceEndSec: endSec,
      fps: fragment.fps,
      ...(highlight.titleStyle ? { titleStyle: highlight.titleStyle } : {}),
    })
  })

  return { plans, skipped }
}

export async function prepareHighlights(
  params: PrepareHighlightsParams,
): Promise<PreparedHighlights> {
  const { selectedItemIds, targetCount, clipDurationSec, titleLanguage, signal } = params
  const { contexts, skippedComps } = await buildClipContexts(selectedItemIds)

  if (contexts.length === 0) {
    throw new Error(
      'No eligible clips selected — Highlight Finder needs video/audio clips with captions or a transcript.',
    )
  }

  const hasContext = contexts.some(
    (clip) => clip.captions.length > 0 || clip.transcriptSegments.length > 0,
  )
  if (!hasContext) {
    throw new Error(
      'Selected clips have no captions or transcripts. Run Analyze with AI or Generate Transcript first.',
    )
  }

  logger.info('Calling Highlight Finder adapter', {
    clips: contexts.length,
    targetCount,
    clipDurationSec,
  })

  const aiHighlights = await findHighlights({
    clips: contexts,
    targetCount,
    clipDurationSec,
    ...(titleLanguage ? { titleLanguage } : {}),
    ...(signal ? { signal } : {}),
  })

  const { plans, skipped } = resolveHighlights(aiHighlights, contexts)
  return {
    plans,
    contexts,
    returnedHighlights: aiHighlights.length,
    skippedHighlights: skipped,
    skippedComps,
  }
}

export const __test = { resolveHighlights, pickBestFragmentForHighlight }
