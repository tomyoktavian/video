/**
 * Token estimation + USD cost projection per LLM model preset.
 *
 * Estimates assume:
 *   - 1 token ≈ 0.75 English words OR ≈ 0.5 Indonesian words
 *   - System prompt + JSON schema overhead ≈ 2k tokens
 *   - Output spoiler 15 min ≈ 15 segments × ~150 words = ~3.5k output tokens
 *
 * The numbers shown to the user are best-effort and may diverge from actual
 * provider invoices by ±15% (provider tokenization, retries, abandoned runs).
 *
 * Prices are hardcoded as of May 2026 and surfaced in the dialog so users can
 * pick a model that fits their budget. Update the `MODEL_PRESETS` constant
 * when prices change.
 */

import type { MediaTranscriptSegment } from '@/types/storage'

export interface ModelPreset {
  id: string
  label: string
  /** Provider context window in tokens. */
  contextWindow: number
  /** Input price per million tokens (USD). */
  inputPricePerMTok: number
  /** Output price per million tokens (USD). */
  outputPricePerMTok: number
  /** Optional vendor-supplied notes (multi-tier pricing, etc.). */
  notes?: string
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    notes: '1M context with opt-in. Best narrative quality / cost trade-off.',
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    contextWindow: 1_000_000,
    inputPricePerMTok: 15,
    outputPricePerMTok: 75,
    notes: 'Premium tier — best for very long or non-linear films.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    inputPricePerMTok: 1,
    outputPricePerMTok: 5,
    notes: 'Cheapest Claude. Narrative may feel shallower for complex films.',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    contextWindow: 128_000,
    inputPricePerMTok: 2.5,
    outputPricePerMTok: 10,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o-mini',
    contextWindow: 128_000,
    inputPricePerMTok: 0.15,
    outputPricePerMTok: 0.6,
    notes: 'Extreme low cost; narration tends to feel listy.',
  },
  {
    id: 'llama-3-3-70b-groq',
    label: 'Llama 3.3 70B (Groq)',
    contextWindow: 128_000,
    inputPricePerMTok: 0.59,
    outputPricePerMTok: 0.79,
    notes: 'Fastest throughput; narrative tone less natural.',
  },
  {
    id: 'gemini-2-5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: 1_000_000,
    inputPricePerMTok: 1.25,
    outputPricePerMTok: 10,
    notes: '$2.50/$15 above 200k context. 1M window, no chunking for 3+hr films.',
  },
]

const SYSTEM_PROMPT_OVERHEAD_TOKENS = 2_000
const TOKENS_PER_WORD = 1.3

export interface TokenEstimate {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface CostEstimate {
  preset: ModelPreset
  inputTokens: number
  outputTokens: number
  totalUsd: number
  /**
   * `true` when the estimated input exceeds the model's context window. The
   * UI surfaces a warning and recommends switching to a larger-context model
   * or enabling chunking (M5).
   */
  exceedsContext: boolean
}

export function estimateTokensForTranscript(
  segments: readonly MediaTranscriptSegment[],
  targetDurationSec: number,
): TokenEstimate {
  let wordCount = 0
  for (const seg of segments) {
    const trimmed = seg.text.trim()
    if (!trimmed) continue
    wordCount += trimmed.split(/\s+/).length
  }
  const transcriptTokens = Math.ceil(wordCount * TOKENS_PER_WORD)
  const inputTokens = transcriptTokens + SYSTEM_PROMPT_OVERHEAD_TOKENS

  // Approx 1 segment per ~60 seconds of spoiler @ ~150 words per segment.
  const outputSegments = Math.max(8, Math.round(targetDurationSec / 60))
  const outputWords = outputSegments * 150
  const outputTokens = Math.ceil(outputWords * TOKENS_PER_WORD) + 500

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  }
}

export function estimateCostForPreset(preset: ModelPreset, estimate: TokenEstimate): CostEstimate {
  const inputUsd = (estimate.inputTokens * preset.inputPricePerMTok) / 1_000_000
  const outputUsd = (estimate.outputTokens * preset.outputPricePerMTok) / 1_000_000
  return {
    preset,
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    totalUsd: inputUsd + outputUsd,
    exceedsContext: estimate.inputTokens >= preset.contextWindow,
  }
}

export function estimateAllPresetCosts(
  segments: readonly MediaTranscriptSegment[],
  targetDurationSec: number,
): { estimate: TokenEstimate; perPreset: CostEstimate[] } {
  const estimate = estimateTokensForTranscript(segments, targetDurationSec)
  const perPreset = MODEL_PRESETS.map((preset) => estimateCostForPreset(preset, estimate))
  return { estimate, perPreset }
}
