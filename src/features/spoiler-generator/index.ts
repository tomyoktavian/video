/**
 * Auto Spoiler Generator — public API barrel.
 *
 * The Spoiler Generator chains existing AI building blocks (Caption Maker,
 * Vision Analyzer, Text-to-Speech) plus a new Script Writer LLM service to
 * turn a long-form film into a condensed spoiler video bundled into a single
 * compound clip.
 */

export {
  prepareSpoilerScript,
  TranscriptMissingError,
  TranscriptTooLargeError,
} from './script-writer-service'
export { writeScript } from './openai-compatible-script-adapter'
export { validateAndClampSegments } from './timestamp-validator'
export { DEFAULT_SCRIPT_WRITER_SYSTEM_PROMPT } from './system-prompt'
export { runSpoilerPipeline } from './spoiler-orchestrator'
export { SpoilerGeneratorDialog } from './components/spoiler-generator-dialog'
export { RegenerateNarrationDialog } from './components/regenerate-narration-dialog'
export { planEpisodes } from './episode-planner'
export type { EpisodeBucket } from './episode-planner'
export { generateEpisodeNarrations, substituteTemplate } from './episode-narration-generator'
export type { EpisodeNarrationLine } from './episode-narration-generator'

export type {
  ScriptWriterRequest,
  SpoilerScript,
  SpoilerSegment,
  SpoilerSegmentRange,
  SpoilerStage,
  SpoilerProgress,
  SpoilerInput,
  SpoilerResult,
  TtsBatchOutcome,
  TtsSegmentSuccess,
  TtsSegmentFailure,
} from './types'
