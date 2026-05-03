/**
 * Custom AI cover-text adapter — sends a single `POST /chat/completions`
 * (text-only) to the OpenAI-compatible endpoint configured in the Vision
 * Analyzer custom-ai slice. Same provider config is reused across vision
 * captioning, highlight finder, and cover text.
 */

import { createLogger } from '@/shared/logging/logger'

import { getCustomAiVisionAnalyzerConfig } from './deps/settings'
import {
  DEFAULT_COVER_FINDER_SYSTEM_PROMPT,
  DEFAULT_POSTER_PROMPT_SYSTEM_PROMPT,
} from './system-prompt'
import type {
  CoverTextRequest,
  CoverTextResponse,
  CoverTextSuggestion,
  PosterPromptRequest,
} from './types'

const logger = createLogger('CoverFinderAdapter')

const USER_MESSAGE_BUDGET_CHARS = 60_000

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

interface OpenAiChatChoice {
  message?: { content?: unknown }
}
interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[]
}

function parseSuggestions(raw: string): CoverTextSuggestion[] {
  if (!raw) return []
  const trimmed = raw.trim()

  const tryParse = (input: string): CoverTextSuggestion[] | null => {
    try {
      const parsed = JSON.parse(input) as { titles?: unknown }
      if (!Array.isArray(parsed.titles)) return []
      return parsed.titles
        .map((entry): CoverTextSuggestion | null => {
          if (!entry || typeof entry !== 'object') return null
          const e = entry as Record<string, unknown>
          const primary = typeof e.primary === 'string' ? e.primary.trim() : ''
          if (primary.length === 0) return null
          const accentRaw = typeof e.accent === 'string' ? e.accent.trim() : ''
          const secondaryRaw = typeof e.secondary === 'string' ? e.secondary.trim() : ''
          return {
            primary,
            ...(accentRaw ? { accent: accentRaw } : {}),
            ...(secondaryRaw ? { secondary: secondaryRaw } : {}),
          }
        })
        .filter((entry): entry is CoverTextSuggestion => entry !== null)
        .slice(0, 3)
    } catch {
      return null
    }
  }

  const direct = tryParse(trimmed)
  if (direct) return direct

  // Strip ```json ... ``` fences some gateways add despite the prompt.
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (fenced !== trimmed) {
    const fencedResult = tryParse(fenced)
    if (fencedResult) return fencedResult
  }

  // Balanced-brace fallback for models that emit prose around the JSON object.
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

function buildUserMessage(request: CoverTextRequest): string {
  const header =
    request.mode === 'transcript'
      ? "Source: VIDEO TRANSCRIPT (use the speaker's actual content for the hook)."
      : 'Source: USER CONTEXT (use this brief to write the hook).'

  const body = request.context.trim()
  const message = `${header}\n\n${body}\n\nReturn JSON only, matching the schema in the system prompt.`

  if (message.length <= USER_MESSAGE_BUDGET_CHARS) return message
  // Hard truncate when transcripts are extremely long. Keep header + tail of
  // the body so the most recent context survives.
  const headerLen = header.length + 4
  const tailBudget = USER_MESSAGE_BUDGET_CHARS - headerLen - 200
  return `${header}\n\n…${body.slice(body.length - tailBudget)}\n\nReturn JSON only, matching the schema in the system prompt.`
}

export async function findCoverText(request: CoverTextRequest): Promise<CoverTextResponse> {
  const config = getCustomAiVisionAnalyzerConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('Custom AI base URL is not configured.')
  if (!apiKey) throw new Error('Custom AI API key is not configured.')
  if (!model) throw new Error('Custom AI model is not selected.')
  if (request.context.trim().length === 0) {
    throw new Error('No context provided — pass a transcript or a manual prompt.')
  }

  const systemPrompt =
    request.systemPromptOverride?.trim() ||
    config.coverFinderPrompt.trim() ||
    DEFAULT_COVER_FINDER_SYSTEM_PROMPT

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
      ...(request.signal ? { signal: request.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      `Cover Finder request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Cover Finder failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const payload = (await response.json()) as OpenAiChatResponse
  const raw = payload.choices?.[0]?.message?.content
  const content = typeof raw === 'string' ? raw : ''
  logger.info('Cover Finder raw response', {
    length: content.length,
    preview: content.slice(0, 300),
  })
  const suggestions = parseSuggestions(content)
  logger.info('Cover Finder returned', { count: suggestions.length })
  return { suggestions }
}

const POSTER_PROMPT_USER_BUDGET_CHARS = 60_000

function buildPosterPromptUserMessage(request: PosterPromptRequest): string {
  const titleLine = `Title: ${request.title.trim() || '(untitled)'}`
  const aspectLine = `Aspect ratio: ${request.aspectLabel.trim() || '1:1'}`
  const transcriptBody = request.transcript.trim()
  const transcriptHeader = 'Transcript:'

  const fixedHeader = `${titleLine}\n${aspectLine}\n\n${transcriptHeader}\n`
  const tailFooter =
    '\n\nWrite ONE poster prompt as plain text only — no JSON, no markdown, no preamble.'
  const transcriptBudget = POSTER_PROMPT_USER_BUDGET_CHARS - fixedHeader.length - tailFooter.length
  const safeTranscript =
    transcriptBody.length <= transcriptBudget
      ? transcriptBody
      : `…${transcriptBody.slice(transcriptBody.length - (transcriptBudget - 1))}`

  return `${fixedHeader}${safeTranscript}${tailFooter}`
}

/**
 * Drafts a single image-generation prompt (plain text) for the Add Cover →
 * Generate with AI flow. Reuses the Vision Analyzer chat-completions config —
 * the resulting string is then handed to the Image Generator adapter.
 */
export async function generatePosterPrompt(request: PosterPromptRequest): Promise<string> {
  const config = getCustomAiVisionAnalyzerConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('Vision Analyzer base URL is not configured.')
  if (!apiKey) throw new Error('Vision Analyzer API key is not configured.')
  if (!model) throw new Error('Vision Analyzer model is not selected.')
  if (request.transcript.trim().length === 0 && request.title.trim().length === 0) {
    throw new Error('Cannot draft a poster prompt without a title or transcript.')
  }

  const systemPrompt =
    request.systemPromptOverride?.trim() ||
    config.posterPromptSystemPrompt.trim() ||
    DEFAULT_POSTER_PROMPT_SYSTEM_PROMPT

  const userMessage = buildPosterPromptUserMessage(request)
  const url = `${trimTrailingSlash(baseUrl)}/chat/completions`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      `Poster prompt request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Poster prompt failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const payload = (await response.json()) as OpenAiChatResponse
  const raw = payload.choices?.[0]?.message?.content
  const content = typeof raw === 'string' ? raw.trim() : ''
  // Strip ```json/```text fences if a gateway adds them.
  const unfenced = content.replace(/^```(?:[a-z]+)?\s*/i, '').replace(/\s*```$/i, '')
  logger.info('Poster prompt response', {
    length: unfenced.length,
    preview: unfenced.slice(0, 300),
  })
  if (unfenced.length === 0) {
    throw new Error('The model returned an empty poster prompt. Try again.')
  }
  return unfenced
}

const TRANSCRIPT_SUMMARY_USER_BUDGET_CHARS = 60_000

const TRANSCRIPT_SUMMARY_SYSTEM_PROMPT = [
  'You distil a verbatim video transcript into a tight summary used as',
  'context for an AI image-generator that paints a cover poster.',
  '',
  'Output requirements:',
  '- 3 to 5 sentences, plain text only. No headings, no markdown, no JSON,',
  '  no preamble. Match the LANGUAGE of the source transcript exactly.',
  '- Preserve the SPECIFIC story arc — main characters (named when stated),',
  '  the central conflict / antagonist, the setting, and the emotional',
  '  hook. Concrete nouns over vague adjectives.',
  '- Keep it lean: 80–160 words. Drop filler words, repetition, ums, and',
  '  off-topic side conversation.',
  '- Do NOT invent characters, locations, or plot beats that are not in',
  '  the transcript.',
].join('\n')

export interface SummariseTranscriptRequest {
  transcript: string
  signal?: AbortSignal
}

/**
 * Compress a long transcript into a tight 3–5 sentence summary suitable for
 * the image-prompt builder. Uses the Vision Analyzer chat-completions
 * config (same provider as the Add Cover → Find frame text generator).
 */
export async function summariseTranscriptForCover(
  request: SummariseTranscriptRequest,
): Promise<string> {
  const config = getCustomAiVisionAnalyzerConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('Vision Analyzer base URL is not configured.')
  if (!apiKey) throw new Error('Vision Analyzer API key is not configured.')
  if (!model) throw new Error('Vision Analyzer model is not selected.')
  const transcriptBody = request.transcript.trim()
  if (transcriptBody.length === 0) {
    throw new Error('Cannot summarise an empty transcript.')
  }

  // Trim from the START (keep the recent / climactic tail) when the
  // transcript exceeds the user-message budget, mirroring how cover-text
  // truncation works.
  const safeTranscript =
    transcriptBody.length <= TRANSCRIPT_SUMMARY_USER_BUDGET_CHARS
      ? transcriptBody
      : `…${transcriptBody.slice(transcriptBody.length - (TRANSCRIPT_SUMMARY_USER_BUDGET_CHARS - 1))}`
  const userMessage = `Transcript:\n${safeTranscript}\n\nReturn only the summary, plain text.`

  const url = `${trimTrailingSlash(baseUrl)}/chat/completions`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TRANSCRIPT_SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      `Transcript summary request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Transcript summary failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const payload = (await response.json()) as OpenAiChatResponse
  const raw = payload.choices?.[0]?.message?.content
  const content = typeof raw === 'string' ? raw.trim() : ''
  const unfenced = content.replace(/^```(?:[a-z]+)?\s*/i, '').replace(/\s*```$/i, '')
  logger.info('Transcript summary response', {
    length: unfenced.length,
    preview: unfenced.slice(0, 300),
  })
  if (unfenced.length === 0) {
    throw new Error('The model returned an empty summary. Try again.')
  }
  return unfenced
}

export const __test = { parseSuggestions, buildUserMessage, buildPosterPromptUserMessage }
