/**
 * Episode boundary narration — synthesizes the TTS opening/closing lines that
 * top and tail each episode produced in Episode Mode.
 *
 * Episode 1 has no opening; the last episode has no closing. For N episodes,
 * the generator emits exactly `2 * (N - 1)` audio lines (or `0` when N === 1).
 * Each line is imported into the media library tagged
 * `'spoiler-episode-boundary'` so the user can audit/cleanup if needed.
 */

import { mediaLibraryService } from './deps/media-library'
import {
  getSpoilerTtsEngineTags,
  runSpoilerTts,
  type SpoilerTtsEngineConfig,
} from './tts-engine-adapter'
import type { EpisodeBucket } from './episode-planner'

const DEFAULT_CUSTOM_ENGINE_CONFIG: SpoilerTtsEngineConfig = { engine: 'custom' }
const EPISODE_BOUNDARY_TAG = 'spoiler-episode-boundary'

const PLACEHOLDER_PATTERN = /\{(n|next)\}/g

export interface EpisodeNarrationLine {
  kind: 'opening' | 'closing'
  /** 1-based episode this line belongs to. */
  episodeIndex: number
  /** Substituted text actually fed into TTS. */
  text: string
  /** Media library entry id for the synthesized audio. */
  mediaId: string
  /** Object URL pointing at the audio blob — caller must revoke when done. */
  blobUrl: string
  durationSec: number
}

/**
 * Substitute `{n}` and `{next}` placeholders. Unknown placeholders are left
 * untouched; surrounding text is preserved verbatim.
 */
export function substituteTemplate(template: string, vars: { n: number; next: number }): string {
  return template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (key === 'n') return String(vars.n)
    if (key === 'next') return String(vars.next)
    return _match
  })
}

export interface GenerateEpisodeNarrationsInput {
  episodes: readonly EpisodeBucket[]
  openingTemplate: string
  closingTemplate: string
  engineConfig?: SpoilerTtsEngineConfig
  speed?: number
  projectId: string
  signal?: AbortSignal
  onProgress?: (current: number, total: number) => void
}

export async function generateEpisodeNarrations(
  input: GenerateEpisodeNarrationsInput,
): Promise<EpisodeNarrationLine[]> {
  const lines: EpisodeNarrationLine[] = []
  const total = countLines(input.episodes)
  if (total === 0) return lines

  let completed = 0
  input.onProgress?.(0, total)

  for (const bucket of input.episodes) {
    if (input.signal?.aborted) throw new DOMException('aborted', 'AbortError')

    if (bucket.includesOpening) {
      const text = substituteTemplate(input.openingTemplate, {
        n: bucket.episodeIndex,
        next: bucket.episodeIndex + 1,
      })
      const line = await synthesize(input, text, 'opening', bucket.episodeIndex)
      lines.push(line)
      completed += 1
      input.onProgress?.(completed, total)
    }

    if (bucket.includesClosing) {
      const text = substituteTemplate(input.closingTemplate, {
        n: bucket.episodeIndex,
        next: bucket.episodeIndex + 1,
      })
      const line = await synthesize(input, text, 'closing', bucket.episodeIndex)
      lines.push(line)
      completed += 1
      input.onProgress?.(completed, total)
    }
  }

  return lines
}

function countLines(episodes: readonly EpisodeBucket[]): number {
  let acc = 0
  for (const e of episodes) {
    if (e.includesOpening) acc += 1
    if (e.includesClosing) acc += 1
  }
  return acc
}

async function synthesize(
  input: GenerateEpisodeNarrationsInput,
  text: string,
  kind: 'opening' | 'closing',
  episodeIndex: number,
): Promise<EpisodeNarrationLine> {
  const engineConfig = input.engineConfig ?? DEFAULT_CUSTOM_ENGINE_CONFIG
  const result = await runSpoilerTts(engineConfig, {
    text,
    speed: input.speed ?? 1,
    ...(input.signal ? { signal: input.signal } : {}),
  })

  const media = await mediaLibraryService.importGeneratedAudio(result.file, input.projectId, {
    tags: [...getSpoilerTtsEngineTags(engineConfig), EPISODE_BOUNDARY_TAG],
  })

  const blobUrl =
    (await mediaLibraryService.getMediaBlobUrl(media.id)) ?? URL.createObjectURL(result.blob)

  return {
    kind,
    episodeIndex,
    text,
    mediaId: media.id,
    blobUrl,
    durationSec: result.duration,
  }
}

export const __test = { synthesize, countLines }
