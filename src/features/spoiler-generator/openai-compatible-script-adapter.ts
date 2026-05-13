/**
 * Script Writer adapter — sends a single `POST /chat/completions` to the
 * OpenAI-compatible endpoint configured in the Vision Analyzer custom-ai
 * slice. Same provider config is reused for vision captioning, highlight
 * reasoning, cover-text generation, and now full-transcript script writing.
 *
 * Returns a {@link SpoilerScript} parsed from the model output. The forgiving
 * parser tolerates fenced JSON blocks and prose preambles to match the
 * behaviour of gateways that strip the `response_format` hint.
 */

import { createLogger } from '@/shared/logging/logger'

import { getCustomAiVisionAnalyzerConfig } from './deps/settings'
import { DEFAULT_SCRIPT_WRITER_SYSTEM_PROMPT } from './system-prompt'
import type {
  ScriptWriterRequest,
  SpoilerScript,
  SpoilerSegment,
  SpoilerSegmentRange,
} from './types'

const logger = createLogger('SpoilerScriptAdapter')

const USER_MESSAGE_BUDGET_CHARS = 200_000

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

interface OpenAiChatChoice {
  message?: { content?: unknown }
}
interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[]
}

const LANGUAGE_LABELS: Record<string, string> = {
  id: 'Bahasa Indonesia',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese (Mandarin)',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
  vi: 'Vietnamese',
  th: 'Thai',
  ms: 'Malay',
  it: 'Italian',
}

// Average spoken words-per-second by narration language. Defaults to 2.5
// (Indonesian) which is close enough for most languages we ship.
const WORDS_PER_SECOND: Record<string, number> = {
  id: 2.5,
  en: 2.8,
  es: 2.6,
  fr: 2.6,
  de: 2.4,
  ja: 4.5, // syllabic, characters-per-second equivalent
  ko: 3.5,
  zh: 3.5,
  pt: 2.6,
  ru: 2.3,
  ar: 2.4,
  hi: 2.5,
  vi: 3.0,
  th: 3.0,
  ms: 2.5,
  it: 2.6,
}

function resolveLanguageLabel(code: string | undefined): string {
  if (!code) return 'Bahasa Indonesia'
  const normalized = code.trim().toLowerCase()
  if (!normalized || normalized === 'auto') return 'Bahasa Indonesia'
  return LANGUAGE_LABELS[normalized] ?? code.trim()
}

function resolveWordsPerSecond(code: string | undefined): number {
  if (!code) return 2.5
  const normalized = code.trim().toLowerCase()
  if (!normalized || normalized === 'auto') return 2.5
  return WORDS_PER_SECOND[normalized] ?? 2.5
}

function parseSegmentRange(value: unknown): SpoilerSegmentRange | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const startSec = typeof v.startSec === 'number' ? v.startSec : Number(v.startSec)
  const endSec = typeof v.endSec === 'number' ? v.endSec : Number(v.endSec)
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null
  if (endSec <= startSec) return null
  return { startSec, endSec }
}

function parseSegment(entry: unknown, fallbackIndex: number): SpoilerSegment | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const narration = typeof e.narration === 'string' ? e.narration.trim() : ''
  if (!narration) return null
  const range = parseSegmentRange(e.selectedClipRange)
  if (!range) return null
  const indexRaw = typeof e.index === 'number' ? e.index : Number(e.index)
  const index = Number.isFinite(indexRaw) ? Math.max(0, Math.floor(indexRaw)) : fallbackIndex
  const rationaleRaw = typeof e.rationale === 'string' ? e.rationale.trim() : ''
  const estRaw =
    typeof e.estimatedNarrationSec === 'number'
      ? e.estimatedNarrationSec
      : Number(e.estimatedNarrationSec)
  const estimatedNarrationSec =
    Number.isFinite(estRaw) && estRaw > 0
      ? estRaw
      : Math.max(2, Math.round((narration.split(/\s+/).length / 2.5) * 10) / 10)
  return {
    index,
    narration,
    selectedClipRange: range,
    ...(rationaleRaw ? { rationale: rationaleRaw } : {}),
    estimatedNarrationSec,
  }
}

export function parseScriptResponse(raw: string): SpoilerScript | null {
  if (!raw) return null
  const trimmed = raw.trim()

  const tryParse = (input: string): SpoilerScript | null => {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') return null
      const segmentsRaw = (parsed as { segments?: unknown }).segments
      if (!Array.isArray(segmentsRaw)) return null
      const segments = segmentsRaw
        .map((entry, i) => parseSegment(entry, i))
        .filter((entry): entry is SpoilerSegment => entry !== null)
      if (segments.length === 0) return null
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : 'Spoiler'
      const synopsis = typeof parsed.synopsis === 'string' ? parsed.synopsis.trim() : ''
      return { title: title || 'Spoiler', synopsis, segments }
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
  return null
}

function buildUserMessage(request: ScriptWriterRequest): string {
  const lang = resolveLanguageLabel(request.narrationLanguage)
  const wps = resolveWordsPerSecond(request.narrationLanguage)
  const targetMin = (request.targetDurationSec / 60).toFixed(1)

  // Hard word-count budgets so the LLM cannot return short narrations and
  // force the orchestrator to pad clips with silent video tails. The
  // upper bound includes a 5% safety margin so the spoiler is "slightly long"
  // rather than "slightly short".
  const targetTotalWords = Math.round(request.targetDurationSec * wps)
  const totalWordsLow = Math.round(targetTotalWords * 0.95)
  const totalWordsHigh = Math.round(targetTotalWords * 1.05)
  const targetSegmentCount = Math.max(
    8,
    Math.round(request.targetDurationSec / Math.max(5, request.clipDurationSec)),
  )
  const targetWordsPerBeat = Math.round(request.clipDurationSec * wps)
  const wordsPerBeatLow = Math.round(targetWordsPerBeat * 0.8)
  const wordsPerBeatHigh = Math.round(targetWordsPerBeat * 1.2)

  const lines: string[] = []
  lines.push(
    `Write a spoiler-recap script for this film. Target spoiler video duration: ~${targetMin} minutes (${request.targetDurationSec.toFixed(0)} seconds).`,
  )
  lines.push(
    `Average per-beat clip duration: ~${request.clipDurationSec.toFixed(1)} seconds. Each \`selectedClipRange\` length should be close to this.`,
  )
  lines.push(
    `Narration language: ${lang}. Spoken rate ≈ ${wps.toFixed(1)} words/sec. Write all \`narration\`, \`title\`, and \`synopsis\` fields in ${lang}.`,
  )
  lines.push('')
  lines.push('## Length budget — HARD targets, not suggestions')
  lines.push(
    `- **Total narration words**: ${totalWordsLow}–${totalWordsHigh} (target ${targetTotalWords}). Anything shorter produces silent gaps in the final video.`,
  )
  lines.push(`- **Number of beats**: about ${targetSegmentCount} (derive from clip duration).`)
  lines.push(
    `- **Words per beat**: ${wordsPerBeatLow}–${wordsPerBeatHigh} (target ${targetWordsPerBeat}). A ${request.clipDurationSec.toFixed(0)}s clip MUST have a narration that takes the full clip to read aloud.`,
  )
  lines.push(
    '- Achieve this by adding context, motivation, consequences, and emotional reflection — not filler. Be vivid and specific.',
  )
  lines.push('')
  lines.push('Return JSON only, matching the schema in the system prompt.')
  lines.push('')

  if (request.perChunkSummaries.length > 0) {
    lines.push('## Earlier-portion summaries (chronological)')
    for (let i = 0; i < request.perChunkSummaries.length; i++) {
      lines.push(`### Chunk ${i + 1}`)
      lines.push(request.perChunkSummaries[i] ?? '')
      lines.push('')
    }
  }

  lines.push('## Transcript (source-media seconds)')
  for (const seg of request.transcript) {
    const text = seg.text.trim()
    if (!text) continue
    lines.push(`- ${seg.start.toFixed(2)}s–${seg.end.toFixed(2)}s: ${text}`)
  }

  let message = lines.join('\n')
  if (message.length > USER_MESSAGE_BUDGET_CHARS) {
    message = message.slice(0, USER_MESSAGE_BUDGET_CHARS)
  }
  return message
}

export async function writeScript(request: ScriptWriterRequest): Promise<SpoilerScript> {
  const config = getCustomAiVisionAnalyzerConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('Custom AI base URL is not configured.')
  if (!apiKey) throw new Error('Custom AI API key is not configured.')
  if (!model) throw new Error('Custom AI model is not selected.')

  const systemPrompt =
    request.systemPromptOverride?.trim() ||
    config.scriptWriterPrompt.trim() ||
    DEFAULT_SCRIPT_WRITER_SYSTEM_PROMPT

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
      `Script Writer request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Script Writer failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }

  const payload = (await response.json()) as OpenAiChatResponse
  const raw = payload.choices?.[0]?.message?.content
  const content = typeof raw === 'string' ? raw : ''
  logger.info('Script Writer raw response', {
    length: content.length,
    preview: content.slice(0, 300),
  })
  const script = parseScriptResponse(content)
  if (!script) {
    throw new Error('Script Writer returned an unparseable response.')
  }
  logger.info('Script Writer returned', {
    title: script.title,
    segmentCount: script.segments.length,
  })
  return script
}

export const __test = { parseScriptResponse, buildUserMessage, resolveLanguageLabel }
