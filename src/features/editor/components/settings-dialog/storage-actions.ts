import { toast } from 'sonner'
import type { MediaMetadata } from '@/types/storage'
import {
  useMediaLibraryStore,
  getSharedProxyKey,
  importProxyService,
  importMediaLibraryService,
  importThumbnailGenerator,
} from '@/features/editor/deps/media-library'
import {
  importGifFrameCache,
  importFilmstripCache,
  importWaveformCache,
} from '@/features/editor/deps/timeline-cache'
import { clearPreviewAudioCache } from '@/features/editor/deps/composition-runtime'
import { createLogger } from '@/shared/logging/logger'

const log = createLogger('SettingsDialog')

export interface BatchActionResult {
  total: number
  succeeded: number
  failed: number
  failedItems: string[]
}

export interface ActionFeedback {
  tone: 'success' | 'error'
  message: string
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function formatFailedItems(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length <= 2) return items.join(', ')
  return `${items.slice(0, 2).join(', ')}, +${items.length - 2} more`
}

function createBatchResult(total: number, failedItems: string[]): BatchActionResult {
  return {
    total,
    succeeded: Math.max(0, total - failedItems.length),
    failed: failedItems.length,
    failedItems,
  }
}

export function getBatchOutcomeFeedback(
  actionLabel: string,
  result: BatchActionResult,
): ActionFeedback {
  if (result.total === 0) {
    return {
      tone: 'success',
      message: `No project media to ${actionLabel.toLowerCase()}.`,
    }
  }

  if (result.failed === 0) {
    return {
      tone: 'success',
      message: `${actionLabel} completed for ${formatCount(result.succeeded, 'item')}.`,
    }
  }

  const failedLabel = formatFailedItems(result.failedItems)

  if (result.succeeded === 0) {
    return {
      tone: 'error',
      message: `Couldn't ${actionLabel.toLowerCase()} ${formatCount(result.failed, 'item')}${failedLabel ? `: ${failedLabel}` : '.'}`,
    }
  }

  return {
    tone: 'error',
    message: `${actionLabel} completed for ${result.succeeded}/${result.total} items. Needs attention: ${failedLabel}.`,
  }
}

export function showBatchOutcomeToast(
  successTitle: string,
  partialTitle: string,
  failureTitle: string,
  result: BatchActionResult,
): void {
  if (result.total === 0) {
    toast.success(successTitle, {
      description: 'No project media needed updating.',
    })
    return
  }

  if (result.failed === 0) {
    toast.success(successTitle, {
      description: `${formatCount(result.succeeded, 'item')} updated.`,
    })
    return
  }

  const description =
    result.succeeded === 0
      ? formatFailedItems(result.failedItems)
      : `${formatCount(result.succeeded, 'item')} updated. Failed: ${formatFailedItems(result.failedItems)}`

  toast.error(result.succeeded === 0 ? failureTitle : partialTitle, {
    description,
  })
}

/**
 * Clear regenerable cache data for the current project's media only.
 * Clears filmstrips, waveforms, GIF frames, and decoded audio
 * scoped to the given media IDs.
 *
 * Does NOT clear thumbnails (not auto-regenerated) or proxies (separate action).
 */
export async function clearProjectCaches(
  mediaItems: Array<Pick<MediaMetadata, 'id' | 'fileName'>>,
): Promise<BatchActionResult> {
  if (mediaItems.length === 0) return createBatchResult(0, [])

  const [
    { deleteWaveform, deleteGifFrames, deleteDecodedPreviewAudio },
    { deletePreviewAudioConform },
    { gifFrameCache },
    { filmstripCache },
    { waveformCache },
  ] = await Promise.all([
    import('@/infrastructure/storage'),
    import('@/features/editor/deps/composition-runtime'),
    importGifFrameCache(),
    importFilmstripCache(),
    importWaveformCache(),
  ])

  clearPreviewAudioCache()

  const failedItems: string[] = []

  await Promise.all(
    mediaItems.map(async ({ id, fileName }) => {
      const results = await Promise.allSettled([
        deleteWaveform(id),
        deleteGifFrames(id),
        deleteDecodedPreviewAudio(id),
        deletePreviewAudioConform(id, { clearMetadata: true }),
        gifFrameCache.clearMedia(id),
        filmstripCache.clearMedia(id),
        waveformCache.clearMedia(id),
      ])

      const failures = results.filter((result) => result.status === 'rejected')
      if (failures.length > 0) {
        log.warn('Failed to fully clear project cache for media item', {
          mediaId: id,
          fileName,
          failures: failures.map((result) => String(result.reason)),
        })
        failedItems.push(fileName)
      }
    }),
  )

  const result = createBatchResult(mediaItems.length, failedItems)
  log.info(`Cleared caches for ${result.succeeded}/${result.total} media items`)
  return result
}

/** Delete all proxy videos for the given media items and clear their store status. */
export async function clearProjectProxies(mediaItems: MediaMetadata[]): Promise<BatchActionResult> {
  if (mediaItems.length === 0) return createBatchResult(0, [])

  const { proxyService } = await importProxyService()
  const failedItems: string[] = []

  await Promise.all(
    mediaItems.map(async (media) => {
      try {
        await proxyService.deleteProxy(media.id, getSharedProxyKey(media))
        useMediaLibraryStore.getState().clearProxyStatus(media.id)
        proxyService.clearProxyKey(media.id)
      } catch (error) {
        log.warn('Failed to clear proxy for media item', {
          mediaId: media.id,
          fileName: media.fileName,
          error,
        })
        failedItems.push(media.fileName)
      }
    }),
  )

  const result = createBatchResult(mediaItems.length, failedItems)
  log.info(`Cleared proxies for ${result.succeeded}/${result.total} media items`)
  return result
}

/**
 * Regenerate thumbnails for all media in the current project.
 * Fetches each media file, generates a new thumbnail, and saves it to workspace storage.
 */
export async function regenerateProjectThumbnails(
  mediaItems: Array<{ id: string; fileName: string; mimeType: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchActionResult> {
  if (mediaItems.length === 0) return createBatchResult(0, [])

  const [{ mediaLibraryService }, { generateThumbnail }, { saveThumbnail, updateMedia }] =
    await Promise.all([
      importMediaLibraryService(),
      importThumbnailGenerator(),
      import('@/infrastructure/storage'),
    ])

  let succeeded = 0
  const failedItems: string[] = []

  for (const media of mediaItems) {
    try {
      const blob = await mediaLibraryService.getMediaFile(media.id)
      if (!blob) continue

      const file = new File([blob], media.fileName, { type: media.mimeType })
      const thumbnailBlob = await generateThumbnail(file)

      const thumbnailId = crypto.randomUUID()
      await saveThumbnail({
        id: thumbnailId,
        mediaId: media.id,
        blob: thumbnailBlob,
        timestamp: 1,
        width: 320,
        height: 180,
      })

      await updateMedia(media.id, { thumbnailId })

      mediaLibraryService.clearThumbnailCache(media.id)
      succeeded++
    } catch (err) {
      log.warn(`Failed to regenerate thumbnail for ${media.fileName}:`, err)
      failedItems.push(media.fileName)
    }
    onProgress?.(succeeded + failedItems.length, mediaItems.length)
  }

  await useMediaLibraryStore.getState().loadMediaItems()

  const result = createBatchResult(mediaItems.length, failedItems)
  log.info(`Regenerated ${result.succeeded}/${result.total} thumbnails`)
  return result
}
