import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTrackCaptionsDialogStore } from '@/shared/state/track-captions-dialog'
import {
  TranscribeDialog,
  type TranscribeDialogValues,
} from '@/features/timeline/deps/transcribe-dialog'
import {
  mediaTranscriptionService,
  getMediaTranscriptionModelLabel,
} from '@/features/timeline/deps/media-transcription-service'
import { useMediaLibraryStore } from '@/features/timeline/deps/media-library-store'
import { useItemsStore } from '../stores/items-store'
import { createLogger } from '@/shared/logging/logger'
import {
  isTranscriptionCancellationError,
  isTranscriptionOutOfMemoryError,
  TRANSCRIPTION_OOM_HINT,
} from '@/shared/utils/transcription-cancellation'
import {
  getTranscriptionOverallPercent,
  getTranscriptionStageLabel,
} from '@/shared/utils/transcription-progress'
import type { MediaTranscriptProviderId } from '@/types/storage'

const logger = createLogger('TrackCaptionsDialog')

interface MediaGroup {
  mediaId: string
  fileName: string
  clipIds: string[]
}

/**
 * Batch caption generator triggered from a track's right-click menu. Reuses
 * the per-clip {@link TranscribeDialog} chrome but loops through every unique
 * media on the track, transcribing then inserting captions one-by-one with
 * progress reported as `(N/M)`.
 */
export function TrackCaptionsDialog() {
  const isOpen = useTrackCaptionsDialogStore((s) => s.isOpen)
  const trackId = useTrackCaptionsDialogStore((s) => s.trackId)
  const close = useTrackCaptionsDialogStore((s) => s.close)
  const showNotification = useMediaLibraryStore((s) => s.showNotification)

  const groups = useMemo<MediaGroup[]>(() => {
    if (!trackId || !isOpen) return []
    const items = useItemsStore.getState().itemsByTrackId[trackId] ?? []
    const mediaById = useMediaLibraryStore.getState().mediaById
    const map = new Map<string, MediaGroup>()
    for (const item of items) {
      if (item.type !== 'audio' || !item.mediaId) continue
      const existing = map.get(item.mediaId)
      if (existing) {
        existing.clipIds.push(item.id)
      } else {
        map.set(item.mediaId, {
          mediaId: item.mediaId,
          fileName: mediaById[item.mediaId]?.fileName ?? item.mediaId,
          clipIds: [item.id],
        })
      }
    }
    return [...map.values()]
  }, [trackId, isOpen])

  const trackName = useMemo(() => {
    if (!trackId) return ''
    return useItemsStore.getState().tracks.find((t) => t.id === trackId)?.name ?? 'track'
  }, [trackId])

  const totalClipCount = groups.reduce((sum, g) => sum + g.clipIds.length, 0)
  const fileNameLabel =
    groups.length === 0
      ? `${trackName} (no audio clips)`
      : groups.length === 1
        ? `${groups[0]!.fileName} on ${trackName}`
        : `${totalClipCount} clips on ${trackName} (${groups.length} unique files)`

  const [completedMediaCount, setCompletedMediaCount] = useState(0)
  const [currentMediaName, setCurrentMediaName] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const cancelRequestedRef = useRef(false)
  const activeMediaIdRef = useRef<string | null>(null)
  const transcriptStatusByMediaId = useMediaLibraryStore((s) => s.transcriptStatus)
  const transcriptProgressByMediaId = useMediaLibraryStore((s) => s.transcriptProgress)
  const activeMediaProgress = activeMediaIdRef.current
    ? transcriptProgressByMediaId.get(activeMediaIdRef.current)
    : null

  // Per-media progress fragment within the overall batch.
  const overallPercent =
    groups.length === 0
      ? null
      : Math.min(
          100,
          Math.round(
            (completedMediaCount / groups.length) * 100 +
              (activeMediaProgress
                ? getTranscriptionOverallPercent(activeMediaProgress) / groups.length
                : 0),
          ),
        )

  const overallLabel = isRunning
    ? activeMediaProgress
      ? `${currentMediaName ?? 'media'} — ${getTranscriptionStageLabel(activeMediaProgress.stage)} (${completedMediaCount}/${groups.length})`
      : `Transcribing ${completedMediaCount + 1}/${groups.length}: ${currentMediaName ?? '…'}`
    : ''

  useEffect(() => {
    if (!isOpen) {
      setCompletedMediaCount(0)
      setCurrentMediaName(null)
      setIsRunning(false)
      setErrorMessage(null)
      cancelRequestedRef.current = false
      activeMediaIdRef.current = null
    }
  }, [isOpen])

  const handleStart = useCallback(
    async (values: TranscribeDialogValues) => {
      if (groups.length === 0) {
        setErrorMessage('No audio clips with media on this track to transcribe.')
        return
      }
      cancelRequestedRef.current = false
      setIsRunning(true)
      setErrorMessage(null)
      setCompletedMediaCount(0)

      const isCustom = values.provider === 'custom'
      const targetModel = isCustom ? (values.customModelId ?? '') : values.model
      const providerId: MediaTranscriptProviderId = isCustom
        ? 'openai-compatible'
        : 'browser-whisper'
      const modelLabel = isCustom
        ? values.customModelId || 'Custom AI'
        : getMediaTranscriptionModelLabel(values.model)
      const mediaStore = useMediaLibraryStore.getState()

      let successCount = 0
      let insertedItemTotal = 0
      let removedItemTotal = 0

      try {
        for (const group of groups) {
          if (cancelRequestedRef.current) break
          activeMediaIdRef.current = group.mediaId
          setCurrentMediaName(group.fileName)

          try {
            const existingTranscript = await mediaTranscriptionService.getTranscript(group.mediaId)
            const existingProvider = existingTranscript?.provider ?? 'browser-whisper'
            const existingIdentity = isCustom
              ? (existingTranscript?.customModelId ?? '')
              : (existingTranscript?.model ?? '')
            const needsTranscription =
              !existingTranscript ||
              existingProvider !== providerId ||
              existingIdentity !== String(targetModel)

            if (needsTranscription) {
              mediaStore.setTranscriptStatus(group.mediaId, 'queued')
              mediaStore.setTranscriptProgress(group.mediaId, { stage: 'queued', progress: 0 })
              await mediaTranscriptionService.transcribeMedia(group.mediaId, {
                providerId,
                model: targetModel,
                quantization: values.quantization,
                language: values.language || undefined,
                onQueueStatusChange: (state) => {
                  if (state === 'queued') {
                    mediaStore.setTranscriptStatus(group.mediaId, 'queued')
                    mediaStore.setTranscriptProgress(group.mediaId, {
                      stage: 'queued',
                      progress: 0,
                    })
                    return
                  }
                  mediaStore.setTranscriptStatus(group.mediaId, 'transcribing')
                  mediaStore.setTranscriptProgress(group.mediaId, { stage: 'loading', progress: 0 })
                },
                onProgress: (progress) => {
                  useMediaLibraryStore.getState().setTranscriptProgress(group.mediaId, progress)
                },
              })
              mediaStore.setTranscriptStatus(group.mediaId, 'ready')
              mediaStore.clearTranscriptProgress(group.mediaId)
            }

            const result = await mediaTranscriptionService.insertTranscriptAsCaptions(
              group.mediaId,
              {
                clipIds: group.clipIds,
                replaceExisting: true,
                wordsPerCaption: values.wordsPerCaption,
              },
            )
            insertedItemTotal += result.insertedItemCount
            removedItemTotal += result.removedItemCount
            successCount += 1
          } catch (err) {
            if (isTranscriptionCancellationError(err)) {
              mediaStore.setTranscriptStatus(
                group.mediaId,
                (await mediaTranscriptionService.getTranscript(group.mediaId)) ? 'ready' : 'idle',
              )
              mediaStore.clearTranscriptProgress(group.mediaId)
              cancelRequestedRef.current = true
              break
            }
            mediaStore.setTranscriptStatus(group.mediaId, 'error')
            mediaStore.clearTranscriptProgress(group.mediaId)
            logger.warn(`Failed to caption media ${group.mediaId} on track ${trackId}`, err)
          } finally {
            activeMediaIdRef.current = null
            setCompletedMediaCount((prev) => prev + 1)
          }
        }

        if (cancelRequestedRef.current) {
          showNotification({
            type: 'info',
            message: `Caption generation cancelled — ${successCount}/${groups.length} clips done.`,
          })
        } else if (successCount === groups.length) {
          showNotification({
            type: 'success',
            message:
              successCount === 1
                ? `Captions added to 1 clip on ${trackName} with ${modelLabel}`
                : `Captions added to ${insertedItemTotal} text items across ${successCount} clips on ${trackName}`,
          })
          close()
        } else {
          const friendly = `Captioned ${successCount}/${groups.length} clips on ${trackName}; ${groups.length - successCount} failed (see console).`
          setErrorMessage(friendly)
          showNotification({ type: 'error', message: friendly })
        }
        // Acknowledge removed-item count via debug log only (not user-facing).
        if (removedItemTotal > 0) {
          logger.info(
            `Replaced ${removedItemTotal} existing caption text items across ${successCount} media`,
          )
        }
      } catch (err) {
        const fallback = err instanceof Error ? err.message : 'Failed to generate captions'
        setErrorMessage(isTranscriptionOutOfMemoryError(err) ? TRANSCRIPTION_OOM_HINT : fallback)
        showNotification({ type: 'error', message: fallback })
      } finally {
        setIsRunning(false)
        activeMediaIdRef.current = null
      }
    },
    [groups, trackId, trackName, showNotification, close],
  )

  const handleCancel = useCallback(() => {
    cancelRequestedRef.current = true
    if (activeMediaIdRef.current) {
      mediaTranscriptionService.cancelTranscription(activeMediaIdRef.current)
    }
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) return
      if (isRunning) return
      close()
    },
    [close, isRunning],
  )

  // `transcriptStatusByMediaId` is read so the dialog re-renders when
  // background per-media status updates flow in; the value isn't directly
  // used (the live progress comes from `transcriptProgressByMediaId`).
  void transcriptStatusByMediaId

  if (!isOpen || !trackId) return null

  return (
    <TranscribeDialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      fileName={fileNameLabel}
      hasTranscript={false}
      isRunning={isRunning}
      progressPercent={overallPercent}
      progressLabel={overallLabel}
      errorMessage={errorMessage}
      onStart={handleStart}
      onCancel={handleCancel}
    />
  )
}
