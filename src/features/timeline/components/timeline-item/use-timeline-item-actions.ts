import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { i18n } from '@/i18n'
import type { TimelineItem as TimelineItemType } from '@/types/timeline'
import type { AnimatableProperty } from '@/types/keyframe'
import type {
  MediaTranscriptModel,
  MediaTranscriptProviderId,
  MediaTranscriptQuantization,
} from '@/types/storage'
import { useSelectionStore } from '@/shared/state/selection'
import { usePlaybackStore } from '@/shared/state/playback'
import { useClearKeyframesDialogStore } from '@/shared/state/clear-keyframes-dialog'
import { useTtsGenerateDialogStore } from '@/shared/state/tts-generate-dialog'
import { useHighlightFinderDialogStore } from '@/shared/state/highlight-finder-dialog'
import { useAddCoverDialogStore } from '@/shared/state/add-cover-dialog'
import { getTextItemPlainText } from '@/shared/utils/text-item-spans'
import { scheduleAfterPaint } from '@/shared/utils/schedule-after-paint'
import {
  isTranscriptionCancellationError,
  isTranscriptionOutOfMemoryError,
  TRANSCRIPTION_OOM_HINT,
} from '@/shared/utils/transcription-cancellation'
import { useMediaLibraryStore } from '@/features/timeline/deps/media-library-store'
import {
  findReplaceableCaptionItemsForClip,
  getMediaTranscriptionModelLabel,
  mediaTranscriptionService,
} from '@/features/timeline/deps/media-transcription-service'
import { useTimelineStore } from '../../stores/timeline-store'
import { useItemsStore } from '../../stores/items-store'
import { useCompositionNavigationStore } from '../../stores/composition-navigation-store'
import {
  insertFreezeFrame,
  linkItems,
  removeItems,
  reverseItems,
  splitItemAtFrames,
  unlinkItems,
} from '../../stores/actions/item-actions'
import { createPreComp, dissolvePreComp } from '../../stores/actions/composition-actions'
import {
  type TimelineItemOverlay,
  useTimelineItemOverlayStore,
} from '../../stores/timeline-item-overlay-store'
import { useSilenceRemovalDialogStore } from '../../stores/silence-removal-dialog-store'
import { useFillerRemovalDialogStore } from '../../stores/filler-removal-dialog-store'
import { canJoinMultipleItems } from '../../utils/clip-utils'
import { canLinkSelection, hasLinkedItems } from '../../utils/linked-items'
import {
  detectScenes,
  getSceneVerificationModelLabel,
  type VerificationModel,
} from '../../deps/analysis'
import { resolveMediaUrl } from '../../deps/media-library-resolver'
import { useBentoLayoutDialogStore } from '../bento-layout-dialog-store'
import { createLogger } from '@/shared/logging/logger'
import { saveScenes } from '@/infrastructure/storage/workspace-fs/scenes'
import {
  analyzeSilenceForItems,
  applySilencePreviewOverlays,
  DEFAULT_SILENCE_REMOVAL_SETTINGS,
} from '../../utils/silence-removal-preview'
import {
  analyzeFillerWordsForItems,
  applyFillerPreviewOverlays,
  DEFAULT_FILLER_REMOVAL_SETTINGS,
} from '../../utils/filler-word-removal-preview'

const logger = createLogger('UseTimelineItemActions')

const SCENE_DETECTION_OVERLAY_ID = 'scene-detection'

interface UseTimelineItemActionsParams {
  item: TimelineItemType
  isBroken: boolean
  leftNeighbor: TimelineItemType | null
  rightNeighbor: TimelineItemType | null
  segmentOverlays: readonly TimelineItemOverlay[]
}

export function useTimelineItemActions({
  item,
  isBroken,
  leftNeighbor,
  rightNeighbor,
  segmentOverlays,
}: UseTimelineItemActionsParams) {
  const getCanJoinSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length < 2) {
      return false
    }

    const items = useTimelineStore.getState().items
    const selectedItems = selectedItemIds
      .map((id) => items.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    return canJoinMultipleItems(selectedItems)
  }, [])

  const getCanLinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length < 2) {
      return false
    }

    const items = useTimelineStore.getState().items
    return canLinkSelection(items, selectedItemIds)
  }, [])

  const getCanUnlinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length === 0) {
      return false
    }

    const items = useTimelineStore.getState().items
    return selectedItemIds.some((id) => hasLinkedItems(items, id))
  }, [])

  const handleJoinSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length >= 2) {
      const itemById = useItemsStore.getState().itemById
      const selectedItems = selectedItemIds
        .map((id) => itemById[id])
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      if (canJoinMultipleItems(selectedItems)) {
        useTimelineStore.getState().joinItems(selectedItemIds)
      }
    }
  }, [])

  const handleJoinLeft = useCallback(() => {
    if (leftNeighbor) {
      useTimelineStore.getState().joinItems([leftNeighbor.id, item.id])
    }
  }, [leftNeighbor, item.id])

  const handleJoinRight = useCallback(() => {
    if (rightNeighbor) {
      useTimelineStore.getState().joinItems([item.id, rightNeighbor.id])
    }
  }, [rightNeighbor, item.id])

  const handleDelete = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length > 0) {
      useTimelineStore.getState().removeItems(selectedItemIds)
    }
  }, [])

  const handleRippleDelete = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length > 0) {
      useTimelineStore.getState().rippleDeleteItems(selectedItemIds)
    }
  }, [])

  const handleLinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    void linkItems(selectedItemIds)
  }, [])

  const handleUnlinkSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    unlinkItems(selectedItemIds)
  }, [])

  const handleReverseSelected = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    reverseItems(selectedItemIds.length > 0 ? selectedItemIds : [item.id])
  }, [item.id])

  const handleClearAllKeyframes = useCallback(() => {
    useClearKeyframesDialogStore.getState().openClearAll([item.id])
  }, [item.id])

  const handleClearPropertyKeyframes = useCallback(
    (property: AnimatableProperty) => {
      useClearKeyframesDialogStore.getState().openClearProperty([item.id], property)
    },
    [item.id],
  )

  const handleBentoLayout = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    if (selectedItemIds.length < 2) {
      return
    }
    useBentoLayoutDialogStore.getState().open(selectedItemIds)
  }, [])

  const handleFreezeFrame = useCallback(() => {
    if (item.type !== 'video') {
      return
    }
    const { currentFrame } = usePlaybackStore.getState()
    void insertFreezeFrame(item.id, currentFrame)
  }, [item.id, item.type])

  const textContent = item.type === 'text' ? getTextItemPlainText(item) : ''
  const hasSpeakableText = textContent.trim().length > 0

  const handleGenerateAudioFromText = useCallback(() => {
    if (!hasSpeakableText) {
      return
    }
    useTtsGenerateDialogStore.getState().open(textContent, item.id)
  }, [hasSpeakableText, item.id, textContent])

  const handleCaptionGeneration = useCallback(
    (
      model: MediaTranscriptModel | string,
      options?: {
        forceTranscription?: boolean
        replaceExisting?: boolean
        quantization?: MediaTranscriptQuantization
        language?: string
        providerId?: MediaTranscriptProviderId
        modelLabel?: string
        wordsPerCaption?: number
        onError?: (error: unknown) => void
      },
    ) => {
      if ((item.type !== 'video' && item.type !== 'audio') || !item.mediaId || isBroken) {
        return
      }

      const mediaId = item.mediaId
      const clipId = item.id
      const store = useMediaLibraryStore.getState()
      const previousStatus = store.transcriptStatus.get(mediaId) ?? 'idle'
      const forceTranscription = options?.forceTranscription ?? false
      const replaceExisting = options?.replaceExisting ?? false
      const providerId: MediaTranscriptProviderId = options?.providerId ?? 'browser-whisper'
      const isCustomProvider = providerId !== 'browser-whisper'
      const modelLabel =
        options?.modelLabel ??
        (isCustomProvider
          ? String(model)
          : getMediaTranscriptionModelLabel(model as MediaTranscriptModel))

      const run = async () => {
        let updatedTranscriptStatus = previousStatus

        try {
          const existingTranscript = await mediaTranscriptionService.getTranscript(mediaId)
          const existingProvider = existingTranscript?.provider ?? 'browser-whisper'
          const existingIdentity = isCustomProvider
            ? (existingTranscript?.customModelId ?? '')
            : (existingTranscript?.model ?? '')
          const needsTranscription =
            forceTranscription ||
            !existingTranscript ||
            existingProvider !== providerId ||
            existingIdentity !== String(model)

          if (needsTranscription) {
            store.setTranscriptStatus(mediaId, 'queued')
            store.setTranscriptProgress(mediaId, { stage: 'queued', progress: 0 })

            await mediaTranscriptionService.transcribeMedia(mediaId, {
              providerId,
              model,
              quantization: options?.quantization,
              language: options?.language || undefined,
              onQueueStatusChange: (state) => {
                if (state === 'queued') {
                  store.setTranscriptStatus(mediaId, 'queued')
                  store.setTranscriptProgress(mediaId, { stage: 'queued', progress: 0 })
                  return
                }

                store.setTranscriptStatus(mediaId, 'transcribing')
                store.setTranscriptProgress(mediaId, { stage: 'loading', progress: 0 })
              },
              onProgress: (progress) => {
                const mediaLibraryStore = useMediaLibraryStore.getState()
                mediaLibraryStore.setTranscriptProgress(mediaId, progress)
              },
            })

            updatedTranscriptStatus = 'ready'
            store.setTranscriptStatus(mediaId, updatedTranscriptStatus)
            store.clearTranscriptProgress(mediaId)
          } else {
            updatedTranscriptStatus = 'ready'
            store.setTranscriptStatus(mediaId, updatedTranscriptStatus)
            store.clearTranscriptProgress(mediaId)
          }
          const result = await mediaTranscriptionService.insertTranscriptAsCaptions(mediaId, {
            clipIds: [clipId],
            replaceExisting,
            ...(typeof options?.wordsPerCaption === 'number'
              ? { wordsPerCaption: options.wordsPerCaption }
              : {}),
          })

          const successMessage = replaceExisting
            ? result.insertedItemCount > 0
              ? result.removedItemCount > 0
                ? i18n.t('timeline.captions.updatedWithModel', { model: modelLabel })
                : i18n.t('timeline.captions.refreshedWithModel', { model: modelLabel })
              : i18n.t('timeline.captions.removedFromSegment')
            : i18n.t('timeline.captions.addedWithModel', { model: modelLabel })

          store.showNotification({
            type: 'success',
            message: successMessage,
          })
        } catch (error) {
          if (isTranscriptionCancellationError(error)) {
            store.setTranscriptStatus(mediaId, previousStatus)
            store.clearTranscriptProgress(mediaId)
            return
          }

          store.setTranscriptStatus(
            mediaId,
            updatedTranscriptStatus === 'ready' ? 'ready' : 'error',
          )
          store.clearTranscriptProgress(mediaId)
          const fallbackMessage =
            error instanceof Error
              ? error.message
              : i18n.t('timeline.captions.failedGenerateSegment')
          const friendlyMessage = isTranscriptionOutOfMemoryError(error)
            ? TRANSCRIPTION_OOM_HINT
            : fallbackMessage
          options?.onError?.(error)
          store.showNotification({
            type: 'error',
            message: friendlyMessage,
          })
        }
      }

      scheduleAfterPaint(() => {
        void run()
      })
    },
    [item.id, item.mediaId, item.type, isBroken],
  )

  const handleCaptionsFromDialog = useCallback(
    (
      values: {
        provider?: 'local' | 'custom'
        model: MediaTranscriptModel
        customModelId?: string
        quantization: MediaTranscriptQuantization
        language: string
        wordsPerCaption?: number
      },
      hasExistingCaptions: boolean,
      onError?: (error: unknown) => void,
    ) => {
      const isCustom = values.provider === 'custom'
      const targetModel: MediaTranscriptModel | string = isCustom
        ? (values.customModelId ?? '')
        : values.model
      handleCaptionGeneration(targetModel, {
        // The dialog path is always "generate fresh captions". Reusing the
        // current transcript is handled explicitly by "Insert Existing Captions".
        forceTranscription: true,
        replaceExisting: hasExistingCaptions,
        quantization: values.quantization,
        language: values.language,
        providerId: isCustom ? 'openai-compatible' : 'browser-whisper',
        ...(isCustom ? { modelLabel: values.customModelId } : {}),
        ...(typeof values.wordsPerCaption === 'number'
          ? { wordsPerCaption: values.wordsPerCaption }
          : {}),
        onError,
      })
    },
    [handleCaptionGeneration],
  )

  const handleApplyCaptionsFromTranscript = useCallback(() => {
    if ((item.type !== 'video' && item.type !== 'audio') || !item.mediaId || isBroken) {
      return
    }

    const mediaId = item.mediaId
    const clipId = item.id
    const replaceExisting = useItemsStore.getState().replaceableCaptionClipIds.has(clipId)
    const store = useMediaLibraryStore.getState()

    const run = async () => {
      try {
        const existingTranscript = await mediaTranscriptionService.getTranscript(mediaId)
        if (!existingTranscript) {
          throw new Error('Generate a transcript first, then add captions from it.')
        }

        const result = await mediaTranscriptionService.insertTranscriptAsCaptions(mediaId, {
          clipIds: [clipId],
          replaceExisting,
        })

        store.showNotification({
          type: 'success',
          message: replaceExisting
            ? result.insertedItemCount > 0 || result.removedItemCount > 0
              ? i18n.t('timeline.captions.updatedFromTranscript')
              : i18n.t('timeline.captions.removedFromSegment')
            : i18n.t('timeline.captions.addedFromTranscript'),
        })
      } catch (error) {
        store.showNotification({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : i18n.t('timeline.captions.failedUpdateSegment'),
        })
      }
    }

    void run()
  }, [isBroken, item.id, item.mediaId, item.type])

  const handleDeleteCaptions = useCallback(() => {
    if (item.type !== 'video' && item.type !== 'audio') return
    if (!item.mediaId || isBroken) return

    const mediaId = item.mediaId
    const items = useItemsStore.getState().items
    const clip = items.find((entry) => entry.id === item.id)
    if (clip?.type !== 'video' && clip?.type !== 'audio') return

    const captionItems = findReplaceableCaptionItemsForClip(items, clip)
    const store = useMediaLibraryStore.getState()
    if (captionItems.length === 0) {
      store.showNotification({
        type: 'info',
        message: i18n.t('timeline.captions.noCaptionsFound'),
      })
      return
    }

    // Captions count as "transcript-sourced" if their captionSource/source
    // discriminator is 'transcript', or if they're legacy (text items with no
    // captionSource — those predate the discriminator and were always
    // transcript-generated).
    const removedTranscriptCaptions = captionItems.some((entry) => {
      if (entry.type === 'text') {
        return !entry.captionSource || entry.captionSource.type === 'transcript'
      }
      return entry.source.type === 'transcript'
    })

    removeItems(captionItems.map((entry) => entry.id))

    // If we just removed transcript-sourced captions and no other clip of this
    // media still has transcript-sourced captions, wipe the workspace transcript
    // too so the next "Generate Captions" starts in a clean "Generate Transcript"
    // state instead of a "Refresh Transcript" prompt.
    if (removedTranscriptCaptions && store.transcriptStatus.get(mediaId) === 'ready') {
      const itemsAfter = useItemsStore.getState().items
      const otherClips = itemsAfter.filter(
        (entry) =>
          (entry.type === 'audio' || entry.type === 'video') &&
          entry.mediaId === mediaId &&
          entry.id !== item.id,
      )
      const otherTranscriptCaptionsExist = otherClips.some(
        (other) =>
          (other.type === 'audio' || other.type === 'video') &&
          findReplaceableCaptionItemsForClip(itemsAfter, other, 'transcript').length > 0,
      )

      if (!otherTranscriptCaptionsExist) {
        mediaTranscriptionService
          .deleteTranscript(mediaId)
          .then(() => {
            const next = useMediaLibraryStore.getState()
            next.setTranscriptStatus(mediaId, 'idle')
            next.clearTranscriptProgress(mediaId)
          })
          .catch((error) => {
            logger.warn('failed to delete transcript after delete captions', error)
          })
      }
    }

    store.showNotification({
      type: 'success',
      message: i18n.t('timeline.captions.removedFromSegment'),
    })
  }, [isBroken, item.id, item.mediaId, item.type])

  const isSceneDetectionActive = segmentOverlays.some(
    (overlay) => overlay.id === SCENE_DETECTION_OVERLAY_ID,
  )

  const isCompositionItem =
    item.type === 'composition' || (item.type === 'audio' && !!item.compositionId)
  const sourceStart = 'sourceStart' in item ? item.sourceStart : undefined
  const clipFrom = item.from

  // Highlight Finder requires both AI captions AND a ready transcript so the
  // video-clipper output (title card + subtitles) has all the data it needs.
  const canFindHighlights = (() => {
    if (item.type !== 'video' && item.type !== 'audio') return false
    if (!item.mediaId) return false
    const mediaStore = useMediaLibraryStore.getState()
    const media = mediaStore.mediaById[item.mediaId]
    if (!media) return false
    const hasCaptions = (media.aiCaptions?.length ?? 0) > 0
    const hasTranscript = mediaStore.transcriptStatus.get(item.mediaId) === 'ready'
    return hasCaptions && hasTranscript
  })()

  const handleCreatePreComp = useCallback(() => {
    // Capture selection synchronously - context menu close may clear it before the dynamic import resolves.
    const ids = useSelectionStore.getState().selectedItemIds
    createPreComp(undefined, ids)
  }, [])

  const handleFindHighlights = useCallback(() => {
    const ids = useSelectionStore.getState().selectedItemIds
    if (ids.length === 0) return
    useHighlightFinderDialogStore.getState().open(ids)
  }, [])

  const compositionId = item.compositionId
  const itemLabel = item.label
  const handleEnterComposition = useCallback(() => {
    if (!isCompositionItem || !compositionId) {
      return
    }

    useCompositionNavigationStore.getState().enterComposition(compositionId, itemLabel, item.id)
  }, [isCompositionItem, compositionId, itemLabel, item.id])

  const handleDissolveComposition = useCallback(() => {
    if (!isCompositionItem) {
      return
    }

    dissolvePreComp(item.id)
  }, [isCompositionItem, item.id])

  const handleAddCover = useCallback(() => {
    if (!isCompositionItem || !compositionId) {
      return
    }
    useAddCoverDialogStore.getState().open(compositionId)
  }, [isCompositionItem, compositionId])

  const sceneDetectionAbortRef = useRef<AbortController | null>(null)
  const [isRemovingSilence, setIsRemovingSilence] = useState(false)
  const [isRemovingFillers, setIsRemovingFillers] = useState(false)

  useEffect(() => {
    return () => {
      sceneDetectionAbortRef.current?.abort()
    }
  }, [])

  const handleDetectScenes = useCallback(
    (method: 'histogram' | 'optical-flow', verificationModel?: VerificationModel) => {
      if (item.type !== 'video' || !item.mediaId || isBroken) {
        return
      }

      const mediaId = item.mediaId
      const clipId = item.id
      const overlayStore = useTimelineItemOverlayStore.getState()

      const run = async () => {
        sceneDetectionAbortRef.current?.abort()
        const abortController = new AbortController()
        sceneDetectionAbortRef.current = abortController
        let video: HTMLVideoElement | null = null

        try {
          overlayStore.upsertOverlay(clipId, {
            id: SCENE_DETECTION_OVERLAY_ID,
            label: i18n.t('timeline.sceneDetection.detectingScenes'),
            progress: 0,
            tone: 'info',
          })

          const url = await resolveMediaUrl(mediaId)
          video = document.createElement('video')
          video.src = url
          video.muted = true
          video.preload = 'auto'

          await new Promise<void>((resolve, reject) => {
            if (abortController.signal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
            const onAbort = () => {
              reject(new DOMException('Aborted', 'AbortError'))
            }
            abortController.signal.addEventListener('abort', onAbort, { once: true })
            video!.onloadedmetadata = () => {
              abortController.signal.removeEventListener('abort', onAbort)
              resolve()
            }
            video!.onerror = () => {
              abortController.signal.removeEventListener('abort', onAbort)
              reject(new Error('Failed to load video for scene detection'))
            }
          })

          const currentFps = useTimelineStore.getState().fps
          const media = useMediaLibraryStore.getState().mediaById[mediaId]
          const mediaFps = media?.fps ?? currentFps
          const cuts = await detectScenes(video, currentFps, {
            method,
            verificationModel,
            mediaId,
            signal: abortController.signal,
            onProgress: (progress) => {
              const modelLabel = progress.verificationModel
                ? getSceneVerificationModelLabel(progress.verificationModel)
                : 'AI'
              const stageLabels = {
                'optical-flow': `Analyzing ${method === 'histogram' ? 'frames' : 'motion'} (${progress.sceneCuts} candidates)`,
                'loading-model': `Loading ${modelLabel} model (${progress.percent.toFixed(0)}%)`,
                verifying: `Verifying cuts (${progress.sceneCuts}/${progress.totalSamples} confirmed)`,
              }
              const label = stageLabels[progress.stage ?? 'optical-flow']
              useTimelineItemOverlayStore.getState().upsertOverlay(clipId, {
                id: SCENE_DETECTION_OVERLAY_ID,
                label,
                progress: progress.percent,
                tone: 'info',
              })
            },
          })

          // Persist scene cuts to the workspace so the next session/window
          // doesn't need to recompute. Fire-and-forget — UX proceeds regardless.
          if (cuts.length > 0) {
            void saveScenes({
              mediaId,
              service:
                method === 'histogram' ? 'scene-detect-histogram' : 'scene-detect-optical-flow',
              model: verificationModel ?? method,
              method,
              sampleIntervalMs: method === 'histogram' ? 250 : 500,
              verificationModel,
              fps: mediaFps,
              cuts,
            }).catch((error) => logger.warn('Failed to persist scene cuts', error))
          }

          if (cuts.length === 0) {
            toast.info(i18n.t('timeline.sceneDetection.noScenesDetected'))
            return
          }

          const clipDuration = item.durationInFrames
          // sourceStart is in source-native FPS; convert to project FPS for consistent math
          const sourceStartSeconds = (sourceStart ?? 0) / mediaFps
          const sourceStartInProjectFrames = Math.round(sourceStartSeconds * currentFps)
          const splitFrames = cuts
            .map((cut) => cut.frame - sourceStartInProjectFrames)
            .filter((frame) => frame > 0 && frame < clipDuration)
            .map((frame) => frame + clipFrom)

          if (splitFrames.length === 0) {
            toast.info(i18n.t('timeline.sceneDetection.noScenesWithinBounds'))
            return
          }

          const splitCount = splitItemAtFrames(clipId, splitFrames)

          if (splitCount > 0) {
            toast.success(i18n.t('timeline.sceneDetection.splitAtScenes', { count: splitCount }))
          } else {
            toast.info(i18n.t('timeline.sceneDetection.noValidSplitPoints'))
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return
          }
          if (error instanceof Error && error.message.includes('WebGPU')) {
            toast.error(i18n.t('timeline.sceneDetection.requiresWebGpu'))
          } else {
            toast.error(i18n.t('timeline.sceneDetection.failed'))
          }
        } finally {
          if (video) {
            video.onloadedmetadata = null
            video.onerror = null
            video.src = ''
          }
          // Only remove overlay if this run still owns the controller
          if (sceneDetectionAbortRef.current === abortController) {
            useTimelineItemOverlayStore.getState().removeOverlay(clipId, SCENE_DETECTION_OVERLAY_ID)
          }
        }
      }

      void run()
    },
    [clipFrom, isBroken, item.durationInFrames, item.id, item.mediaId, item.type, sourceStart],
  )

  const handleRemoveSilence = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    const targetIds = selectedItemIds.length > 0 ? selectedItemIds : [item.id]
    const targetItems = targetIds
      .map((id) => useItemsStore.getState().itemById[id])
      .filter(
        (candidate): candidate is TimelineItemType =>
          candidate !== undefined &&
          (candidate.type === 'video' || candidate.type === 'audio') &&
          !!candidate.mediaId,
      )

    if (targetItems.length === 0) {
      toast.info(i18n.t('timeline.itemActions.selectAvClipFirst'))
      return
    }

    const run = async () => {
      setIsRemovingSilence(true)
      try {
        const targetItemIds = targetItems.map((target) => target.id)
        const silenceRangesByMediaId = await analyzeSilenceForItems(
          targetItemIds,
          DEFAULT_SILENCE_REMOVAL_SETTINGS,
        )
        const summary = applySilencePreviewOverlays(targetItemIds, silenceRangesByMediaId)

        if (summary.rangeCount === 0) {
          toast.info(i18n.t('timeline.silenceRemoval.noRemovableDetectedShort'))
          return
        }

        useSilenceRemovalDialogStore.getState().open({
          itemIds: targetItemIds,
          settings: DEFAULT_SILENCE_REMOVAL_SETTINGS,
          rangesByMediaId: silenceRangesByMediaId,
          summary,
        })
      } catch (error) {
        logger.warn('Remove silence failed', error)
        toast.error(
          error instanceof Error
            ? error.message
            : i18n.t('timeline.silenceRemoval.toastPreviewFailed'),
        )
      } finally {
        setIsRemovingSilence(false)
      }
    }

    void run()
  }, [item.id])

  const handleRemoveFillers = useCallback(() => {
    const selectedItemIds = useSelectionStore.getState().selectedItemIds
    const targetIds = selectedItemIds.length > 0 ? selectedItemIds : [item.id]
    const targetItems = targetIds
      .map((id) => useItemsStore.getState().itemById[id])
      .filter(
        (candidate): candidate is TimelineItemType =>
          candidate !== undefined &&
          (candidate.type === 'video' || candidate.type === 'audio') &&
          !!candidate.mediaId,
      )

    if (targetItems.length === 0) {
      toast.info(i18n.t('timeline.fillerRemoval.selectAudioOrVideoFirst'))
      return
    }

    const run = async () => {
      setIsRemovingFillers(true)
      try {
        const targetItemIds = targetItems.map((target) => target.id)
        const rangesByMediaId = await analyzeFillerWordsForItems(
          targetItemIds,
          DEFAULT_FILLER_REMOVAL_SETTINGS,
        )
        const summary = applyFillerPreviewOverlays(targetItemIds, rangesByMediaId)

        if (summary.rangeCount === 0) {
          toast.info(i18n.t('timeline.fillerRemoval.noRemovableDetectedShort'))
          return
        }

        useFillerRemovalDialogStore.getState().open({
          itemIds: targetItemIds,
          settings: DEFAULT_FILLER_REMOVAL_SETTINGS,
          rangesByMediaId,
          summary,
        })
      } catch (error) {
        logger.warn('Remove filler words failed', error)
        toast.error(
          error instanceof Error
            ? error.message
            : i18n.t('timeline.fillerRemoval.toastPreviewFailed'),
        )
      } finally {
        setIsRemovingFillers(false)
      }
    }

    void run()
  }, [item.id])

  return {
    getCanJoinSelected,
    getCanLinkSelected,
    getCanUnlinkSelected,
    hasSpeakableText,
    isSceneDetectionActive,
    isRemovingSilence,
    isRemovingFillers,
    isCompositionItem,
    handleJoinSelected,
    handleJoinLeft,
    handleJoinRight,
    handleDelete,
    handleRippleDelete,
    handleLinkSelected,
    handleUnlinkSelected,
    handleReverseSelected,
    handleClearAllKeyframes,
    handleClearPropertyKeyframes,
    handleBentoLayout,
    handleFreezeFrame,
    handleGenerateAudioFromText,
    handleCaptionsFromDialog,
    handleApplyCaptionsFromTranscript,
    handleDeleteCaptions,
    handleCreatePreComp,
    handleEnterComposition,
    handleDissolveComposition,
    handleAddCover,
    handleDetectScenes,
    handleFindHighlights,
    canFindHighlights,
    handleRemoveSilence,
    handleRemoveFillers,
  }
}
