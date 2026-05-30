/**
 * Client-side render hook
 *
 * Provides a React hook for video rendering using mediabunny.
 * Uses blob URLs directly, runs entirely in the browser with WebCodecs.
 *
 * Settings resolution (codec fallback) and worker orchestration live in
 * `../utils/render-pipeline` so this hook and the render queue runner stay in
 * lockstep.
 */

import { useState, useCallback, useRef } from 'react'
import type { ExportSettings, ExtendedExportSettings } from '@/types/export'
import type { RenderProgress, ClientRenderResult, ClientCodec } from '../utils/client-renderer'
import {
  mapToClientSettings,
  getSupportedCodecs,
  formatBytes,
  estimateFileSize,
  getVideoBitrateForQuality,
  getOptimizedVideoBitrate,
} from '../utils/client-renderer'
import { isExtendedSettings, resolveClientSettings, runRender } from '../utils/render-pipeline'
import { convertTimelineToComposition } from '../utils/timeline-to-composition'
import {
  buildSubCompositionInput,
  useCompositionsStore,
  useTimelineStore,
} from '@/features/export/deps/timeline'
import { useProjectStore } from '@/features/export/deps/projects'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import { resolveMediaUrls, getMaxSourceVideoBitrate } from '@/features/export/deps/media-library'
import { usePlaybackStore } from '@/shared/state/playback'
import { createLogger, createOperationId } from '@/shared/logging/logger'

const log = createLogger('Export')

type ClientRenderStatus =
  | 'idle'
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

interface UseClientRenderReturn {
  // State
  isExporting: boolean
  progress: number
  renderedFrames?: number
  totalFrames?: number
  status: ClientRenderStatus
  error: string | null
  result: ClientRenderResult | null

  // Actions
  startExport: (settings: ExportSettings | ExtendedExportSettings) => Promise<void>
  cancelExport: () => void
  downloadVideo: () => void
  resetState: () => void

  // Utilities
  getSupportedCodecs: (options?: {
    resolution?: { width: number; height: number }
    quality?: ExportSettings['quality']
    bitrate?: number
  }) => Promise<ClientCodec[]>
  estimateFileSize: (settings: ExportSettings, durationSeconds: number) => string
}

export function useClientRender(): UseClientRenderReturn {
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [renderedFrames, setRenderedFrames] = useState<number>()
  const [totalFrames, setTotalFrames] = useState<number>()
  const [status, setStatus] = useState<ClientRenderStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ClientRenderResult | null>(null)

  // AbortController for cancellation
  const abortControllerRef = useRef<AbortController | null>(null)

  /**
   * Handle progress updates from the render engine
   */
  const handleProgress = useCallback((progressData: RenderProgress) => {
    setProgress(progressData.progress)
    setRenderedFrames(progressData.currentFrame)
    setTotalFrames(progressData.totalFrames)

    // Map phase to status
    switch (progressData.phase) {
      case 'preparing':
        setStatus('preparing')
        break
      case 'rendering':
        setStatus('rendering')
        break
      case 'encoding':
        setStatus('encoding')
        break
      case 'finalizing':
        setStatus('finalizing')
        break
    }
  }, [])

  /**
   * Start client-side export
   */
  const startExport = useCallback(
    async (settings: ExportSettings | ExtendedExportSettings) => {
      const opId = createOperationId()
      const event = log.startEvent('render', opId)

      try {
        setIsExporting(true)
        setProgress(0)
        setError(null)
        setResult(null)
        setStatus('preparing')

        // Create abort controller for cancellation
        abortControllerRef.current = new AbortController()

        // Determine export scope. When `compositionId` is set, render that
        // sub-composition's contents instead of the main timeline.
        const scopedCompositionId = isExtendedSettings(settings)
          ? settings.compositionId
          : undefined
        const scopedComposition = scopedCompositionId
          ? useCompositionsStore.getState().getComposition(scopedCompositionId)
          : undefined

        if (scopedCompositionId && !scopedComposition) {
          throw new Error(`Compound clip not found: ${scopedCompositionId}`)
        }

        // Read current state from stores. For composition-scoped exports we read
        // the sub-comp's tracks/items/etc.; otherwise we read the main timeline.
        const state = useTimelineStore.getState()
        const tracks = scopedComposition ? scopedComposition.tracks : state.tracks
        const items = scopedComposition ? scopedComposition.items : state.items
        const transitions = scopedComposition ? scopedComposition.transitions : state.transitions
        const keyframes = scopedComposition ? scopedComposition.keyframes : state.keyframes
        const fps = scopedComposition ? scopedComposition.fps : state.fps
        const inPoint = scopedComposition ? null : state.inPoint
        const outPoint = scopedComposition ? null : state.outPoint

        // Get project metadata (background color and native resolution)
        const currentProject = useProjectStore.getState().currentProject
        const busAudioEq = scopedComposition
          ? scopedComposition.busAudioEq
          : usePlaybackStore.getState().busAudioEq
        const masterBusDb = scopedComposition ? undefined : usePlaybackStore.getState().masterBusDb
        const backgroundColor = scopedComposition
          ? scopedComposition.backgroundColor
          : currentProject?.metadata?.backgroundColor
        // Use composition resolution for sub-comp scope, project resolution otherwise
        // (project resolution matches preview transform calculations).
        const projectWidth = scopedComposition
          ? scopedComposition.width
          : (currentProject?.metadata?.width ?? DEFAULT_PROJECT_WIDTH)
        const projectHeight = scopedComposition
          ? scopedComposition.height
          : (currentProject?.metadata?.height ?? DEFAULT_PROJECT_HEIGHT)

        // Resolve settings + codec fallback (one source of truth with the queue).
        const { clientSettings, exportMode, renderWholeProject, codecFallback } =
          await resolveClientSettings(settings, fps)
        if (codecFallback) event.set('codecFallback', codecFallback)

        // When renderWholeProject is true, ignore in/out points. Composition scope
        // never applies in/out points (always renders full sub-comp duration).
        const effectiveInPoint = scopedComposition ? null : renderWholeProject ? null : inPoint
        const effectiveOutPoint = scopedComposition ? null : renderWholeProject ? null : outPoint

        const extended = isExtendedSettings(settings)
        event.merge({
          mode: exportMode,
          fps,
          tracks: tracks.length,
          items: items.length,
          inPoint: effectiveInPoint,
          outPoint: effectiveOutPoint,
          renderWholeProject,
          keyframes: keyframes?.length ?? 0,
          projectResolution: `${projectWidth}x${projectHeight}`,
          videoContainer: extended ? settings.videoContainer : undefined,
          audioContainer: extended ? settings.audioContainer : undefined,
          embedSubtitles: clientSettings.embedSubtitles,
          projectId: currentProject?.id,
          compositionId: scopedCompositionId,
          codec: clientSettings.codec,
          container: clientSettings.container,
          resolution: `${clientSettings.resolution.width}x${clientSettings.resolution.height}`,
        })

        // Optimize bitrate: scale by codec efficiency and resolution. Codec is
        // already resolved (with fallback) by resolveClientSettings above.
        if (exportMode === 'video') {
          clientSettings.videoBitrate = getOptimizedVideoBitrate(
            settings.quality,
            clientSettings.codec,
            clientSettings.resolution,
          )

          // Cap bitrate to source maximum — re-encoding above source bitrate
          // only inflates file size without improving visual quality.
          const maxSourceBitrate = getMaxSourceVideoBitrate(items)
          if (maxSourceBitrate > 0 && clientSettings.videoBitrate > maxSourceBitrate * 1.3) {
            clientSettings.videoBitrate = Math.round(maxSourceBitrate * 1.3)
            event.set('bitrateCapApplied', true)
            event.set('maxSourceBitrate', maxSourceBitrate)
          }

          event.set('optimizedVideoBitrate', clientSettings.videoBitrate)
        }

        // Convert timeline to Composition format (handles I/O point trimming).
        // Use PROJECT resolution so transforms match preview (scaled to export res later).
        // For sub-comp scope, use the dedicated builder (no in/out clamping)
        // and layer in the sub-comp's audio bus settings.
        const composition = scopedComposition
          ? {
              ...buildSubCompositionInput(scopedComposition),
              busAudioEq,
            }
          : convertTimelineToComposition(
              tracks,
              items,
              transitions,
              fps,
              projectWidth,
              projectHeight,
              effectiveInPoint,
              effectiveOutPoint,
              keyframes,
              backgroundColor,
              busAudioEq,
              masterBusDb,
            )

        const totalCompositionItems = composition.tracks.reduce(
          (sum, t) => sum + (t.items?.length ?? 0),
          0,
        )
        const compositionDuration = composition.durationInFrames ?? 0

        event.merge({
          compositionDuration: compositionDuration,
          compositionDurationSec: compositionDuration / fps,
          compositionTracks: composition.tracks.length,
          compositionItems: totalCompositionItems,
        })

        // Resolve media URLs (convert mediaIds to blob URLs)
        // Export always uses full-res source, never proxies
        const resolvedTracks = await resolveMediaUrls(composition.tracks, {
          useProxy: false,
        })
        composition.tracks = resolvedTracks

        // Count resolved items for diagnostics
        let totalResolvedItems = 0
        let itemsWithSrc = 0
        let itemsMissingSrc = 0
        for (const track of resolvedTracks) {
          for (const item of track.items ?? []) {
            totalResolvedItems++
            if ('src' in item && item.src) {
              itemsWithSrc++
            } else if (item.type === 'video' || item.type === 'audio' || item.type === 'image') {
              itemsMissingSrc++
              log.warn('Media item missing src after resolve', {
                opId,
                itemId: item.id,
                type: item.type,
                mediaId: item.mediaId,
              })
            }
          }
        }

        event.merge({
          resolvedItems: totalResolvedItems,
          itemsWithSrc,
          itemsMissingSrc,
        })

        // Run the render (worker, with automatic main-thread fallback).
        const signal = abortControllerRef.current.signal
        const {
          result: renderResult,
          renderPath,
          fallbackReason,
        } = await runRender({
          clientSettings,
          exportMode,
          composition,
          signal,
          onProgress: handleProgress,
        })
        if (fallbackReason) event.set('workerFallbackReason', fallbackReason)

        setResult(renderResult)
        setStatus('completed')
        setProgress(100)

        event.set('renderPath', renderPath)
        event.success({
          fileSize: renderResult.fileSize,
          fileSizeFormatted: formatBytes(renderResult.fileSize),
          duration: renderResult.duration,
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          event.set('outcome', 'cancelled')
          event.set('duration_ms', Date.now())
          log.event('render', { opId, outcome: 'cancelled' })
          setStatus('cancelled')
        } else {
          event.failure(err)
          const message = err instanceof Error ? err.message : 'Failed to export'
          setError(message)
          setStatus('failed')
        }
      } finally {
        setIsExporting(false)
        abortControllerRef.current = null
      }
    },
    [handleProgress],
  )

  /**
   * Cancel the current export. Aborting the controller signals `runRender`,
   * which posts the cancel to its worker and terminates it.
   */
  const cancelExport = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      setStatus('cancelled')
      setIsExporting(false)
    }
  }, [])

  /**
   * Download the rendered video/audio
   */
  const downloadVideo = useCallback(() => {
    if (!result) return

    const url = URL.createObjectURL(result.blob)
    const a = document.createElement('a')
    a.href = url

    // Determine file extension from MIME type
    let extension = 'mp4'
    const mime = result.mimeType.toLowerCase()
    if (mime.includes('webm')) extension = 'webm'
    else if (mime.includes('matroska')) extension = 'mkv'
    else if (mime.includes('quicktime') || mime.includes('mov')) extension = 'mov'
    else if (mime.includes('audio/mpeg') || mime.includes('mp3')) extension = 'mp3'
    else if (mime.includes('audio/wav') || mime.includes('wave')) extension = 'wav'
    else if (mime.includes('audio/aac') || mime.includes('adts')) extension = 'aac'

    a.download = `export-${Date.now()}.${extension}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)

    // Revoke during idle — download has already started by then
    requestIdleCallback(() => URL.revokeObjectURL(url))
  }, [result])

  /**
   * Reset state
   */
  const resetState = useCallback(() => {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setIsExporting(false)
    setProgress(0)
    setRenderedFrames(undefined)
    setTotalFrames(undefined)
    setStatus('idle')
    setError(null)
    setResult(null)
  }, [])

  /**
   * Get supported codecs for the current resolution
   */
  const getSupportedCodecsForResolution = useCallback(
    async (options?: {
      resolution?: { width: number; height: number }
      quality?: ExportSettings['quality']
      bitrate?: number
    }) => {
      const currentProject = useProjectStore.getState().currentProject
      const width =
        options?.resolution?.width ?? currentProject?.metadata?.width ?? DEFAULT_PROJECT_WIDTH
      const height =
        options?.resolution?.height ?? currentProject?.metadata?.height ?? DEFAULT_PROJECT_HEIGHT
      const bitrate =
        options?.bitrate ??
        (options?.quality ? getVideoBitrateForQuality(options.quality) : undefined)

      const codecs = await getSupportedCodecs({ width, height, bitrate })
      return codecs
    },
    [],
  )

  /**
   * Estimate file size for given settings
   */
  const estimateFileSizeForSettings = useCallback(
    (settings: ExportSettings, durationSeconds: number) => {
      const fps = useTimelineStore.getState().fps
      const clientSettings = mapToClientSettings(settings, fps)
      const bytes = estimateFileSize(clientSettings, durationSeconds)
      return formatBytes(bytes)
    },
    [],
  )

  return {
    isExporting,
    progress,
    renderedFrames,
    totalFrames,
    status,
    error,
    result,
    startExport,
    cancelExport,
    downloadVideo,
    resetState,
    getSupportedCodecs: getSupportedCodecsForResolution,
    estimateFileSize: estimateFileSizeForSettings,
  }
}
