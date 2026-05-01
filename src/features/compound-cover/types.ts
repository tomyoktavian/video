/**
 * Types shared across the Add Cover (compound-cover) feature.
 *
 * A "cover" is a Vlog-style intro card placed at frame 0 of a compound clip's
 * internal timeline: a chosen video frame as the background, with bold
 * highlighted title text rendered as plain TextItems on a fresh top track.
 */

export type CoverTextMode = 'transcript' | 'manual-prompt' | 'manual-text'

/**
 * One title suggestion returned by the AI cover-text endpoint. Three slots
 * map directly to the Vlog template:
 *
 * - `primary`   — top line, white bold all-caps (≤ 4 words)
 * - `accent`    — coloured highlight word(s) on the second line (1-2 words)
 * - `secondary` — supporting line under the accent (≤ 7 words)
 */
export interface CoverTextSuggestion {
  primary: string
  accent?: string
  secondary?: string
}

export interface CoverTextRequest {
  mode: 'transcript' | 'manual-prompt'
  /**
   * For `transcript` mode: a flat string built by joining transcript text from
   * every video/audio item inside the compound clip. The adapter does NOT
   * fetch transcripts itself — the service layer assembles this string.
   *
   * For `manual-prompt` mode: the user-typed context, e.g. "video wedding
   * Sari & Andi" or "podcast tentang produktivitas".
   */
  context: string
  systemPromptOverride?: string
  signal?: AbortSignal
}

export interface CoverTextResponse {
  /** Up to 3 suggestions; first is the recommended pick. */
  suggestions: CoverTextSuggestion[]
}
