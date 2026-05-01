/**
 * Custom AI Highlight Finder adapter — sends a single
 * `POST /chat/completions` (text-only, no images) to the OpenAI-compatible
 * endpoint configured in the Vision Analyzer custom-ai slice. Same provider
 * config is reused for both vision captioning and highlight reasoning.
 */

import { getCustomAiVisionAnalyzerConfig } from './deps/settings'
import { createLogger } from '@/shared/logging/logger'

import { DEFAULT_HIGHLIGHT_FINDER_SYSTEM_PROMPT } from './system-prompt'
import type { AiHighlight, HighlightFinderRequest } from './types'

const logger = createLogger('HighlightFinderAdapter')

const USER_MESSAGE_BUDGET_CHARS = 80_000

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

interface OpenAiChatChoice {
  message?: { content?: unknown }
}
interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[]
}

function parseHighlightsResponse(raw: string): AiHighlight[] {
  if (!raw) return []
  const trimmed = raw.trim()

  const tryParse = (input: string): AiHighlight[] | null => {
    try {
      const parsed = JSON.parse(input) as { highlights?: unknown }
      if (!Array.isArray(parsed.highlights)) return []
      return parsed.highlights
        .map((entry): AiHighlight | null => {
          if (!entry || typeof entry !== 'object') return null
          const e = entry as Record<string, unknown>
          const mediaId = typeof e.mediaId === 'string' ? e.mediaId : ''
          const startTimeSec = typeof e.startTimeSec === 'number' ? e.startTimeSec : NaN
          const endTimeSec = typeof e.endTimeSec === 'number' ? e.endTimeSec : NaN
          if (!mediaId || !Number.isFinite(startTimeSec) || !Number.isFinite(endTimeSec)) {
            return null
          }
          if (endTimeSec <= startTimeSec) return null
          const title = typeof e.title === 'string' ? e.title : undefined
          const rationale = typeof e.rationale === 'string' ? e.rationale : undefined
          const titleStyle = typeof e.titleStyle === 'string' ? e.titleStyle : undefined
          return {
            mediaId,
            startTimeSec,
            endTimeSec,
            ...(title ? { title } : {}),
            ...(rationale ? { rationale } : {}),
            ...(titleStyle ? { titleStyle } : {}),
          }
        })
        .filter((entry): entry is AiHighlight => entry !== null)
    } catch {
      return null
    }
  }

  const direct = tryParse(trimmed)
  if (direct) return direct

  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (fenced !== trimmed) {
    const fencedResult = tryParse(fenced)
    if (fencedResult) return fencedResult
  }

  // Balanced-block fallback.
  const start = fenced.indexOf('{')
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < fenced.length; i++) {
      const ch = fenced[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const block = tryParse(fenced.slice(start, i + 1))
          if (block) return block
          break
        }
      }
    }
  }
  return []
}

function buildClipBlock(
  clip: HighlightFinderRequest['clips'][number],
  index: number,
  options: { includeTranscript: boolean },
): string {
  const lines: string[] = []
  lines.push(
    `### Clip ${index + 1} (mediaId="${clip.mediaId}", file="${clip.mediaFileName}", sourceStartSec=${clip.sourceStartSec.toFixed(2)}, sourceEndSec=${clip.sourceEndSec.toFixed(2)})`,
  )
  const MAX_CAPTIONS_PER_CLIP = 60
  const captionsToShow =
    clip.captions.length > MAX_CAPTIONS_PER_CLIP
      ? clip.captions.filter(
          (_, i) => i % Math.ceil(clip.captions.length / MAX_CAPTIONS_PER_CLIP) === 0,
        )
      : clip.captions
  if (captionsToShow.length > 0) {
    lines.push('Visual captions:')
    for (const caption of captionsToShow) {
      const tagBits: string[] = []
      if (caption.sceneData?.shotType) tagBits.push(`shot:${caption.sceneData.shotType}`)
      if (caption.sceneData?.action) tagBits.push(`action:${caption.sceneData.action}`)
      if (caption.sceneData?.subjects?.length)
        tagBits.push(`subjects:${caption.sceneData.subjects.join(', ')}`)
      if (caption.sceneData?.setting) tagBits.push(`setting:${caption.sceneData.setting}`)
      if (caption.sceneData?.lighting) tagBits.push(`lighting:${caption.sceneData.lighting}`)
      const tag = tagBits.length > 0 ? ` [${tagBits.join(' | ')}]` : ''
      lines.push(`- ${caption.timeSec.toFixed(2)}s: ${caption.text}${tag}`)
    }
  }
  if (options.includeTranscript && clip.transcriptSegments.length > 0) {
    lines.push('Transcript:')
    for (const seg of clip.transcriptSegments) {
      lines.push(`- ${seg.start.toFixed(2)}s–${seg.end.toFixed(2)}s: ${seg.text.trim()}`)
    }
  }
  return lines.join('\n')
}

function buildUserMessage(request: HighlightFinderRequest): string {
  const header = [
    `Pick exactly ${request.targetCount} highlights.`,
    `Each highlight must be approximately ${request.clipDurationSec.toFixed(1)} seconds long. Trim to the nearest sentence or scene boundary within ±20% of this target.`,
    'Return JSON only, matching the schema in the system prompt. Use the mediaId values exactly as listed.',
    '',
  ].join('\n')

  // Try with transcripts first.
  const fullBlocks = request.clips.map((clip, i) =>
    buildClipBlock(clip, i, { includeTranscript: true }),
  )
  const fullMessage = `${header}\n${fullBlocks.join('\n\n')}`
  if (fullMessage.length <= USER_MESSAGE_BUDGET_CHARS) return fullMessage

  // Drop transcripts entirely.
  const captionsOnly = request.clips.map((clip, i) =>
    buildClipBlock(clip, i, { includeTranscript: false }),
  )
  const captionsOnlyMessage = `${header}\n${captionsOnly.join('\n\n')}`
  if (captionsOnlyMessage.length <= USER_MESSAGE_BUDGET_CHARS) return captionsOnlyMessage

  // Hard truncate at the budget.
  return captionsOnlyMessage.slice(0, USER_MESSAGE_BUDGET_CHARS)
}

export async function findHighlights(request: HighlightFinderRequest): Promise<AiHighlight[]> {
  const config = getCustomAiVisionAnalyzerConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('Custom AI base URL is not configured.')
  if (!apiKey) throw new Error('Custom AI API key is not configured.')
  if (!model) throw new Error('Custom AI model is not selected.')

  const systemPrompt =
    request.systemPromptOverride?.trim() ||
    config.highlightFinderPrompt.trim() ||
    DEFAULT_HIGHLIGHT_FINDER_SYSTEM_PROMPT

  const userMessage = buildUserMessage(request)
  const url = `${trimTrailingSlash(baseUrl)}/chat/completions`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // No `response_format` — see openai-compatible-vision-provider for why.
      // The system prompt enforces JSON-only output; the forgiving parser
      // tolerates fences/extra text from gateways that strip the format hint.
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: request.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      `Highlight Finder request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Highlight Finder failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const payload = (await response.json()) as OpenAiChatResponse
  const raw = payload.choices?.[0]?.message?.content
  const content = typeof raw === 'string' ? raw : ''
  logger.info('Highlight Finder raw response', {
    length: content.length,
    preview: content.slice(0, 300),
  })
  const highlights = parseHighlightsResponse(content)
  logger.info('Highlight Finder returned', { count: highlights.length })
  return highlights
}

export const __test = { parseHighlightsResponse, buildUserMessage }
