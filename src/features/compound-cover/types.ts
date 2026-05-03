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

/**
 * Request for {@link generatePosterPrompt} — the chat-completions step that
 * turns the compound's title + transcript + aspect-ratio label into a single
 * plain-text prompt for the Image Generator.
 */
export interface PosterPromptRequest {
  /** The compound clip's display name (becomes the topic anchor). */
  title: string
  /**
   * Concatenated transcript of every video/audio item inside the compound,
   * already assembled by the service layer (same source as `gatherCompositionTranscript`).
   * May be empty when no transcripts exist; the service rejects that case
   * before calling the adapter.
   */
  transcript: string
  /** Aspect-ratio label like "16:9", "9:16", "1:1" — composed into the user message. */
  aspectLabel: string
  systemPromptOverride?: string
  signal?: AbortSignal
}

/**
 * Request for the OpenAI-compatible image-generator adapter. The adapter
 * resolves `(width, height)` to a provider-friendly `size` string and also
 * sends `aspect_ratio: "<W>:<H>"` for providers that respect it.
 */
export interface CoverImageRequest {
  prompt: string
  width: number
  height: number
  /**
   * Optional quality tier forwarded to the provider as the OpenAI
   * `quality` field. `gpt-image-1` recognises `low | medium | high | auto`;
   * other providers (Gemini "nano-banana", Grok / Aurora, most Stability
   * proxies) silently ignore it. The adapter omits the field when this is
   * undefined or `'auto'` so providers that error on unknown values stay
   * happy.
   */
  quality?: 'low' | 'medium' | 'high' | 'auto'
  signal?: AbortSignal
}

/** Response from the image-generator adapter — a single rendered poster. */
export interface CoverImageResponse {
  blob: Blob
  /** Width/height of the returned image in pixels (after decode). */
  width: number
  height: number
  /** MIME type of the blob (e.g. `image/png`, `image/jpeg`). */
  mimeType: string
}
