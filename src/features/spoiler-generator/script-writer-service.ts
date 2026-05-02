/**
 * High-level Script Writer service.
 *
 * Pipeline:
 *   1. Load the transcript from workspace storage.
 *   2. (M5) Optionally chunk + summarize when transcript exceeds limits.
 *   3. Call the OpenAI-compatible adapter to generate a {@link SpoilerScript}.
 *   4. Validate + clamp segments against the transcript.
 *
 * The orchestrator's "writing-script" stage delegates entirely to
 * {@link prepareSpoilerScript}.
 */

import { writeScript } from './openai-compatible-script-adapter'
import { getTranscript } from './deps/transcription'
import { validateAndClampSegments } from './timestamp-validator'
import { chunkAndSummarizeIfNeeded, type TranscriptChunk } from './transcript-chunker'
import { getCustomAiVisionAnalyzerConfig } from './deps/settings'
import type { SpoilerScript } from './types'

/**
 * Hard ceiling — transcripts beyond this size cannot be processed even with
 * chunking enabled. The chunker recursively summarises everything but the
 * final scene; if the original transcript is so large that summary tokens
 * also blow the budget, we surface a friendly error rather than silently
 * dropping content.
 */
const TRANSCRIPT_SIZE_HARD_CAP_CHARS = 1_500_000

/**
 * Threshold above which the chunker activates. Below this, the full
 * transcript is sent to the Script Writer in a single call.
 */
export const TRANSCRIPT_CHUNKING_THRESHOLD_CHARS = 60_000

const SUMMARIZER_SYSTEM_PROMPT = [
  'You are a film summariser. The user will give you a chunk of a movie',
  'transcript with timestamps. Produce a 200–350 word plain-prose summary',
  'of what happens in that chunk that captures: who is on screen, the major',
  'plot beats, key revelations, and emotional shifts. Refer to characters',
  'consistently. Do NOT output a bulleted list, JSON, or markdown headings',
  '— output a single paragraph in English. Output ONLY the summary.',
].join('\n')

async function summariseChunk(
  chunk: TranscriptChunk,
  signal: AbortSignal | undefined,
): Promise<string> {
  const config = getCustomAiVisionAnalyzerConfig()
  const baseUrl = config.baseUrl.trim()
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const userMsg = chunk.segments
    .map((s) => `- ${s.start.toFixed(2)}s–${s.end.toFixed(2)}s: ${s.text.trim()}`)
    .join('\n')
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    }),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Chunk summarizer failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    )
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const raw = payload.choices?.[0]?.message?.content
  return typeof raw === 'string' ? raw.trim() : ''
}

export interface PrepareScriptParams {
  mediaId: string
  /** Target spoiler video duration in seconds (e.g. 900 = 15 min). */
  targetDurationSec: number
  /** ISO-639-1 narration language. Empty = Bahasa Indonesia default. */
  narrationLanguage: string
  /** Average per-beat clip duration in seconds. */
  clipDurationSec: number
  /** Empty = use the user's configured / default system prompt. */
  systemPromptOverride?: string
  signal?: AbortSignal
}

export class TranscriptMissingError extends Error {
  constructor(public readonly mediaId: string) {
    super(`Transcript not found for media ${mediaId}. Run "Transcribe" first.`)
    this.name = 'TranscriptMissingError'
  }
}

export class TranscriptTooLargeError extends Error {
  constructor(public readonly chars: number) {
    super(
      `Transcript is too large to process in one call (${chars} chars). ` +
        'Long-film chunking is a future feature; for now use a shorter source ' +
        'or wait for M5 chunking support.',
    )
    this.name = 'TranscriptTooLargeError'
  }
}

function computeTranscriptCharCount(segments: ReadonlyArray<{ text: string }>): number {
  let total = 0
  for (const s of segments) total += s.text.length
  return total
}

export async function prepareSpoilerScript(params: PrepareScriptParams): Promise<SpoilerScript> {
  const transcript = await getTranscript(params.mediaId)
  if (!transcript || transcript.segments.length === 0) {
    throw new TranscriptMissingError(params.mediaId)
  }

  const charCount = computeTranscriptCharCount(transcript.segments)
  if (charCount > TRANSCRIPT_SIZE_HARD_CAP_CHARS) {
    throw new TranscriptTooLargeError(charCount)
  }

  const language = params.narrationLanguage?.trim() || 'id'

  const prepared = await chunkAndSummarizeIfNeeded({
    segments: transcript.segments,
    thresholdCharLength: TRANSCRIPT_CHUNKING_THRESHOLD_CHARS,
    summarize: (chunk) => summariseChunk(chunk, params.signal),
    ...(params.signal ? { signal: params.signal } : {}),
  })

  const raw = await writeScript({
    transcript: prepared.flatTranscript,
    perChunkSummaries: prepared.chunkSummaries,
    targetDurationSec: params.targetDurationSec,
    narrationLanguage: language,
    clipDurationSec: params.clipDurationSec,
    ...(params.systemPromptOverride ? { systemPromptOverride: params.systemPromptOverride } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  })

  return validateAndClampSegments(raw, transcript.segments, {
    minClipDurationSec: 0.5,
    snapToleranceSec: 5,
    dropToleranceSec: 15,
  })
}
