/**
 * Types shared across the Auto Spoiler Generator feature.
 *
 * The pipeline takes a long-form film (1-2 hours) and produces a single
 * compound clip containing condensed video segments + AI-generated narration
 * (TTS) + optional subtitles + optional cover, ready for MP4 export.
 */

import type { MediaTranscriptSegment } from '@/types/storage'
import type { SubtitleGranularity } from './deps/settings'

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
  /**
   * Subtitle word-grouping granularity. When undefined, the orchestrator
   * falls back to the global `defaultSubtitleGranularity` setting.
   */
  subtitleGranularity?: SubtitleGranularity
  /** TTS voice id; falls back to config voice when undefined. */
  voicePreset?: string
  /** TTS speed multiplier (0.25 .. 4.0). Undefined = provider default (1.0). */
  voiceSpeed?: number
}

/**
 * Persisted on the resulting `SubComposition` so the user can later
 * regenerate narration (and subtitles) in place from the compositions
 * section context menu without losing the script + segment selection +
 * cover. The presence of this field is the discriminator that distinguishes
 * spoiler-generated compounds from manually-created pre-comps.
 */
export interface SpoilerCompositionMetadata {
  /** Schema version. Bump when the shape changes incompatibly. */
  version: 1
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
  /** Subtitle granularity used at generation time. */
  granularity: SubtitleGranularity
  /** Whether subtitles were generated. */
  addSubtitles: boolean
  /** Whether a cover was inserted. */
  generateCover: boolean
  /** Whether the "Spoiler Original Audio" track was created. */
  includeOriginalAudio: boolean
  /** Source film media id. */
  sourceFilmMediaId: string
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
