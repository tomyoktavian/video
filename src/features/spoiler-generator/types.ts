/**
 * Types shared across the Auto Spoiler Generator feature.
 *
 * The pipeline takes a long-form film (1-2 hours) and produces a single
 * compound clip containing condensed video segments + AI-generated narration
 * (TTS) + optional subtitles + optional cover, ready for MP4 export.
 */

import type { MediaTranscriptSegment } from '@/types/storage'

/** Time range in source-media seconds. */
export interface SpoilerSegmentRange {
  startSec: number
  endSec: number
}

/**
 * One narrative beat. The Script Writer outputs an array of these; each
 * beat picks a clip range from the source film and writes a narration line
 * that summarises what is happening in that range.
 */
export interface SpoilerSegment {
  /** Stable index assigned by the Script Writer (0-based). */
  index: number
  /** Narration text in the target language. Spoken by TTS. */
  narration: string
  /** Source-media seconds — the clip range to keep from the original film. */
  selectedClipRange: SpoilerSegmentRange
  /** Optional editorial reasoning ("why this scene"). */
  rationale?: string
  /**
   * Best-effort estimate of how long the narration will take to read aloud.
   * Used for cost estimation + as a hint for clip-duration sync. The actual
   * duration comes from the TTS audio file.
   */
  estimatedNarrationSec: number
}

export interface SpoilerScript {
  /** Catchy spoiler title — used for the cover card. */
  title: string
  /** One-paragraph synopsis (not spoken — for UI / cover subtitle). */
  synopsis: string
  /** Ordered narrative beats. */
  segments: SpoilerSegment[]
}

/** Wire-format request sent to the OpenAI-compatible chat-completions adapter. */
export interface ScriptWriterRequest {
  /** Full-coverage transcript segments (source-media seconds). */
  transcript: readonly MediaTranscriptSegment[]
  /**
   * Optional pre-summarised chunk descriptions when the transcript is too
   * long to fit in one call. Empty when not chunked. M5 feature.
   */
  perChunkSummaries: readonly string[]
  /** Target spoiler video duration in seconds (e.g. 900 = 15 min). */
  targetDurationSec: number
  /**
   * ISO-639-1 code for the narration language (e.g. `'id'`, `'en'`).
   * Defaults to `'id'` (Bahasa Indonesia) per product decision.
   */
  narrationLanguage: string
  /** Average target duration per spoiler segment clip in seconds. */
  clipDurationSec: number
  /** Empty string = use the default system prompt. */
  systemPromptOverride?: string
  signal?: AbortSignal
}

/** State machine stages exposed to the progress UI. */
export type SpoilerStage =
  | 'idle'
  | 'transcribing'
  | 'writing-script'
  | 'resolving-highlights'
  | 'applying-highlights'
  | 'generating-narration'
  | 'transcribing-narration'
  | 'planning-episodes'
  | 'generating-episode-narration'
  | 'inserting-subtitles'
  | 'inserting-cover'
  | 'syncing-durations'
  | 'done'
  | 'error'

export interface SpoilerProgress {
  stage: SpoilerStage
  message: string
  /** Optional 0..1 fraction within the current stage. */
  fraction?: number
  /** For per-segment stages (TTS batch). */
  segmentIndex?: number
  segmentTotal?: number
}

export interface SpoilerInput {
  /** Source media id (the long-form film). */
  mediaId: string
  /** Target spoiler video duration in seconds. */
  targetDurationSec: number
  /** Narration language ISO-639-1. */
  narrationLanguage: string
  /** Average per-segment clip duration in seconds. */
  clipDurationSec: number
  generateCover: boolean
  addSubtitles: boolean
  /**
   * Whether to add the dedicated "Spoiler Original Audio" track (source film
   * audio ducked under narration). When false, only the narration track is
   * audible — useful when the user wants a clean voice-over without the
   * original soundtrack bleeding through.
   */
  includeOriginalAudio: boolean
  /** TTS voice id; falls back to config voice when undefined. */
  voicePreset?: string
  /** TTS speed multiplier (0.25 .. 4.0). Undefined = provider default (1.0). */
  voiceSpeed?: number
  /**
   * Words per spoiler subtitle text item. `1` = karaoke (one word per clip);
   * higher = bigger phrase chunks. Only consulted when `addSubtitles === true`.
   * Clamped to `[1, 20]`.
   */
  wordsPerCaption?: number
  /**
   * Episode mode — when true the spoiler is split into multiple compound
   * clips (one per episode), each with optional TTS opening/closing lines
   * synthesized at boundaries. The cover image is generated once and reused
   * across all episodes. When undefined or false, the pipeline produces a
   * single compound (legacy behavior).
   */
  episodeMode?: boolean
  /** Min seconds per episode. Clamped to `[60, 119]`. Default 60. */
  episodeMinDurationSec?: number
  /** Max seconds per episode. Clamped to `[61, 120]`. Default 120. */
  episodeMaxDurationSec?: number
  /**
   * Template for the TTS line spoken at the start of episodes 2..N.
   * Episode 1 has no opening (only closing). Substitutions:
   *   `{n}`    — current episode number (1-based)
   *   `{next}` — next episode number
   * Default: "Selamat datang di episode {n}".
   */
  episodeOpeningTemplate?: string
  /**
   * Template for the TTS line spoken at the end of episodes 1..N-1. The last
   * episode has no closing (only opening). Same placeholders as
   * {@link episodeOpeningTemplate}.
   * Default: "Lanjutkan nonton di episode {next}".
   */
  episodeClosingTemplate?: string
  /**
   * Target number of episodes. When provided, the planner partitions segments
   * into exactly this many buckets (subject to a minimum of 1 and capped at
   * `segments.length`). When omitted, the greedy bin-packer derives the count
   * from {@link episodeMinDurationSec} / {@link episodeMaxDurationSec}.
   */
  episodeCount?: number
  /**
   * AI-generated cover image, already persisted to the media library by the
   * dialog before the pipeline starts. When set, the orchestrator skips
   * `renderCoverFrame()` and reuses this asset across every produced
   * compound (per-episode boundaries + the full-duration spoiler compound).
   */
  preGeneratedCover?: {
    mediaId: string
    src: string
    width: number
    height: number
  }
  /**
   * Cover preroll duration in seconds. Used both for the legacy `insertCover`
   * call on the full / non-episode compound AND, in episode mode, as a
   * leading silent window where the cover image plays alone BEFORE the
   * opening narration starts. Clamped to `[0.5, 5]`. Default 4.
   */
  coverDurationSec?: number
  /**
   * Client-side playback rate applied to the opening/closing TTS audio items
   * in episode mode. This is a guaranteed mechanism that does not depend on
   * the TTS provider honoring the server-side `speed` parameter — the
   * AudioItem's `speed` field directly accelerates timeline playback. Range
   * `[0.5, 4.0]`. Default 1.0 (no extra speed-up beyond TTS).
   */
  boundaryNarrationSpeed?: number
}

/**
 * Persisted on the resulting `SubComposition` so the user can later
 * regenerate narration (and subtitles) in place from the compositions
 * section context menu without losing the script + segment selection +
 * cover. The presence of this field is the discriminator that distinguishes
 * spoiler-generated compounds from manually-created pre-comps.
 *
 * Schema is structurally permissive: v1 records validate as v2 with all v2
 * fields undefined, so downstream consumers (regen-narration, compositions
 * panel UI) read shared v1 fields without narrowing. New v2 fields are
 * populated only when the compound was produced in Episode Mode.
 */
export interface SpoilerCompositionMetadata {
  /** Schema version. `1` = single-compound; `2` = adds episode fields. */
  version: 1 | 2
  /** Epoch ms — bumped on initial generation and every regen. */
  generatedAt: number
  /** Per-segment data needed to rebuild narration in place. */
  segments: ReadonlyArray<SpoilerSegmentMetadata>
  /** Voice id used for TTS (null = provider default voice). */
  voiceId: string | null
  /** Speed multiplier used for TTS. */
  speed: number
  /** ISO-639-1 narration language. */
  language: string
  /** Spoiler title from the script (used for cover regen reference). */
  scriptTitle: string
  /** Optional one-paragraph synopsis from the script. */
  scriptSynopsis?: string
  /** Whether subtitles were generated. */
  addSubtitles: boolean
  /**
   * Words per subtitle text item used when this spoiler was generated.
   * Persisted so later regen-narration runs match the original look.
   * Optional for backward compat with legacy metadata (callers fall back
   * to `1`).
   */
  wordsPerCaption?: number
  /** Whether a cover was inserted. */
  generateCover: boolean
  /** Whether the "Spoiler Original Audio" track was created. */
  includeOriginalAudio: boolean
  /** Source film media id. */
  sourceFilmMediaId: string
  // ── v2 fields (Episode Mode) — undefined when version === 1 ────────────
  /** 1-based episode index. `null` on v2 records that aren't part of an episode group. */
  episodeIndex?: number | null
  /** Total episodes produced in the same Episode Mode run. */
  episodeTotal?: number | null
  /**
   * Correlation id shared by all sibling episodes of the same Episode Mode
   * run. Lets the UI group / re-stitch episodes later.
   */
  parentSpoilerRunId?: string | null
  /** AudioItem id of the synthesized opening narration (null if no opening). */
  episodeOpeningNarrationItemId?: string | null
  /** AudioItem id of the synthesized closing narration (null if no closing). */
  episodeClosingNarrationItemId?: string | null
  /** Substituted opening text (e.g. "Selamat datang di episode 2"). */
  episodeOpeningText?: string | null
  /** Substituted closing text (e.g. "Lanjutkan nonton di episode 3"). */
  episodeClosingText?: string | null
  /**
   * Media id of the cover image asset shared across all sibling episodes.
   * Same id appears on every episode in the run.
   */
  coverFrameMediaId?: string | null
}

export interface SpoilerSegmentMetadata {
  /** 0-based, matches the original script segment ordering. */
  index: number
  /** Narration text fed into TTS — preserved for re-runs. */
  narrationText: string
  /** AudioItem id on the "Spoiler Narration" track. */
  narrationItemId: string
  /** VideoItem id on the "Spoiler Video" track. */
  videoItemId: string
  /**
   * AudioItem id on the "Spoiler Original Audio" track. Null when
   * `includeOriginalAudio` was false at generation time.
   */
  originalAudioItemId: string | null
  /** TextItem ids on the subtitle track for this segment (empty when subtitles off). */
  subtitleItemIds: ReadonlyArray<string>
  /** Source-film clip range in seconds. */
  sourceClipRange: { start: number; end: number }
}

export interface SpoilerResult {
  compositionId: string
  segmentsRequested: number
  segmentsApplied: number
  narrationsGenerated: number
  narrationsFailed: number
  totalDurationSec: number
}

/** TTS batch outcome — discriminated union per segment. */
export interface TtsSegmentSuccess {
  index: number
  blob: Blob
  durationSec: number
  /** Saved media library entry id for the narration audio. */
  mediaId: string
  error?: never
}

export interface TtsSegmentFailure {
  index: number
  error: string
  blob?: never
  mediaId?: never
}

export type TtsBatchOutcome = TtsSegmentSuccess | TtsSegmentFailure
