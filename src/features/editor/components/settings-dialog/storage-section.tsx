import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Loader2, Check, ImagePlus, Film, TriangleAlert, Trash2 } from 'lucide-react'
import {
  LocalInferenceUnloadControl,
  LocalModelCacheControl,
} from '@/features/editor/deps/settings'
import {
  useMediaLibraryStore,
  getSharedProxyKey,
  importProxyService,
  importMediaLibraryService,
} from '@/features/editor/deps/media-library'
import { createLogger } from '@/shared/logging/logger'
import { cn } from '@/shared/ui/cn'
import {
  type ActionFeedback,
  clearProjectCaches,
  clearProjectProxies,
  getBatchOutcomeFeedback,
  regenerateProjectThumbnails,
  showBatchOutcomeToast,
} from './storage-actions'

const log = createLogger('SettingsDialog')

export function StorageSection() {
  const { t } = useTranslation()
  const mediaItems = useMediaLibraryStore((s) => s.mediaItems)
  const proxyStatus = useMediaLibraryStore((s) => s.proxyStatus)

  const [clearState, setClearState] = useState<'idle' | 'clearing' | 'done' | 'partial'>('idle')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [regenState, setRegenState] = useState<'idle' | 'working' | 'done' | 'partial'>('idle')
  const [regenProgress, setRegenProgress] = useState('')
  const [proxyState, setProxyState] = useState<'idle' | 'clearing' | 'done' | 'partial'>('idle')
  const [proxyGenerateState, setProxyGenerateState] = useState<'idle' | 'queueing' | 'done'>('idle')
  const [clearFeedback, setClearFeedback] = useState<ActionFeedback | null>(null)
  const [regenFeedback, setRegenFeedback] = useState<ActionFeedback | null>(null)
  const [proxyFeedback, setProxyFeedback] = useState<ActionFeedback | null>(null)

  const handleClearCache = useCallback(async () => {
    setClearState('clearing')
    try {
      const items = mediaItems.map((m) => ({ id: m.id, fileName: m.fileName }))
      const result = await clearProjectCaches(items)
      const feedback = getBatchOutcomeFeedback('Clear Cache', result)
      setClearFeedback(feedback)
      setClearState(result.failed === 0 ? 'done' : 'partial')
      showBatchOutcomeToast(
        t('settings.toasts.projectCacheCleared'),
        t('settings.toasts.projectCachePartiallyCleared'),
        t('settings.toasts.projectCacheNotCleared'),
        result,
      )
      setTimeout(() => setClearState('idle'), 2000)
    } catch (err) {
      log.error('Failed to clear caches', err)
      setClearFeedback({
        tone: 'error',
        message: t('settings.feedback.couldntClearCache'),
      })
      toast.error(t('settings.toasts.failedToClearCache'))
      setClearState('idle')
    }
  }, [mediaItems, t])

  const handleRegenThumbnails = useCallback(async () => {
    setRegenState('working')
    setRegenProgress('0/' + mediaItems.length)
    try {
      const items = mediaItems.map((m) => ({
        id: m.id,
        fileName: m.fileName,
        mimeType: m.mimeType,
      }))
      const result = await regenerateProjectThumbnails(items, (done, total) => {
        setRegenProgress(`${done}/${total}`)
      })
      const feedback = getBatchOutcomeFeedback('Regenerate Thumbnails', result)
      setRegenFeedback(feedback)
      setRegenState(result.failed === 0 ? 'done' : 'partial')
      showBatchOutcomeToast(
        t('settings.toasts.thumbnailsRegenerated'),
        t('settings.toasts.thumbnailsPartiallyRegenerated'),
        t('settings.toasts.thumbnailsNotRegenerated'),
        result,
      )
      setTimeout(() => {
        setRegenState('idle')
        setRegenProgress('')
      }, 2000)
    } catch (err) {
      log.error('Failed to regenerate thumbnails', err)
      setRegenFeedback({
        tone: 'error',
        message: t('settings.feedback.couldntRegenerateThumbnails'),
      })
      toast.error(t('settings.toasts.failedToRegenerateThumbnails'))
      setRegenState('idle')
      setRegenProgress('')
    }
  }, [mediaItems, t])

  const handleClearProxies = useCallback(async () => {
    setProxyState('clearing')
    try {
      const result = await clearProjectProxies(mediaItems)
      const feedback = getBatchOutcomeFeedback('Delete Proxies', result)
      setProxyFeedback(feedback)
      setProxyState(result.failed === 0 ? 'done' : 'partial')
      showBatchOutcomeToast(
        t('settings.toasts.proxiesDeleted'),
        t('settings.toasts.proxiesPartiallyDeleted'),
        t('settings.toasts.proxiesNotDeleted'),
        result,
      )
      setTimeout(() => setProxyState('idle'), 2000)
    } catch (err) {
      log.error('Failed to clear proxies', err)
      setProxyFeedback({
        tone: 'error',
        message: t('settings.feedback.couldntDeleteProxies'),
      })
      toast.error(t('settings.toasts.failedToDeleteProxies'))
      setProxyState('idle')
    }
  }, [mediaItems, t])

  const handleGenerateMissingProxies = useCallback(async () => {
    setProxyGenerateState('queueing')

    try {
      const [{ proxyService }, { mediaLibraryService }] = await Promise.all([
        importProxyService(),
        importMediaLibraryService(),
      ])

      const queuedItems = mediaItems.filter((media) => {
        if (!proxyService.canGenerateProxy(media.mimeType)) {
          return false
        }

        const sharedProxyKey = getSharedProxyKey(media)
        if (proxyService.hasProxy(media.id, sharedProxyKey)) {
          return false
        }

        const status = useMediaLibraryStore.getState().proxyStatus.get(media.id)
        return status !== 'ready' && status !== 'generating'
      })

      queuedItems.forEach((media) => {
        const sharedProxyKey = getSharedProxyKey(media)
        proxyService.setProxyKey(media.id, sharedProxyKey)
        proxyService.generateProxy(
          media.id,
          media.storageType === 'opfs' && media.opfsPath
            ? { kind: 'opfs', path: media.opfsPath, mimeType: media.mimeType }
            : () => mediaLibraryService.getMediaFile(media.id),
          media.width,
          media.height,
          sharedProxyKey,
          { priority: 'background' },
        )
      })

      setProxyGenerateState('done')
      setTimeout(() => setProxyGenerateState('idle'), 2000)
    } catch (err) {
      log.error('Failed to queue missing proxies', err)
      setProxyGenerateState('idle')
    }
  }, [mediaItems])

  const missingProjectProxyCount = mediaItems.filter(
    (media) =>
      media.mimeType.startsWith('video/') &&
      proxyStatus.get(media.id) !== 'ready' &&
      proxyStatus.get(media.id) !== 'generating',
  ).length

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">{t('settings.storage.generateMissingProxies')}</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings.storage.generateMissingProxiesDescription')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-28 gap-1.5"
            onClick={handleGenerateMissingProxies}
            disabled={proxyGenerateState !== 'idle' || missingProjectProxyCount === 0}
          >
            {proxyGenerateState === 'queueing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {proxyGenerateState === 'done' && <Check className="w-3.5 h-3.5" />}
            {proxyGenerateState === 'idle' && <Film className="w-3.5 h-3.5" />}
            {proxyGenerateState === 'queueing'
              ? t('settings.storage.queueing')
              : proxyGenerateState === 'done'
                ? t('settings.storage.queued')
                : missingProjectProxyCount > 0
                  ? t('settings.storage.generateWithCount', { count: missingProjectProxyCount })
                  : t('settings.storage.upToDate')}
          </Button>
        </div>
        <Separator className="bg-white/8" />
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">{t('settings.storage.clearProjectCache')}</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings.storage.clearProjectCacheDescription')}
            </p>
            {clearFeedback && (
              <p
                className={cn(
                  'mt-1 text-xs',
                  clearFeedback.tone === 'error' ? 'text-amber-400' : 'text-muted-foreground',
                )}
              >
                {clearFeedback.message}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-28 gap-1.5"
            onClick={() => setShowClearConfirm(true)}
            disabled={clearState !== 'idle'}
          >
            {clearState === 'clearing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {clearState === 'done' && <Check className="w-3.5 h-3.5" />}
            {clearState === 'partial' && <TriangleAlert className="w-3.5 h-3.5" />}
            {clearState === 'idle' && <Trash2 className="w-3.5 h-3.5" />}
            {clearState === 'clearing'
              ? t('settings.storage.clearing')
              : clearState === 'done'
                ? t('settings.storage.cleared')
                : clearState === 'partial'
                  ? t('settings.storage.partial')
                  : t('settings.storage.clear')}
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">{t('settings.storage.regenerateThumbnails')}</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings.storage.regenerateThumbnailsDescription')}
            </p>
            {regenFeedback && (
              <p
                className={cn(
                  'mt-1 text-xs',
                  regenFeedback.tone === 'error' ? 'text-amber-400' : 'text-muted-foreground',
                )}
              >
                {regenFeedback.message}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-28 gap-1.5"
            onClick={handleRegenThumbnails}
            disabled={regenState !== 'idle'}
          >
            {regenState === 'working' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {regenState === 'done' && <Check className="w-3.5 h-3.5" />}
            {regenState === 'partial' && <TriangleAlert className="w-3.5 h-3.5" />}
            {regenState === 'idle' && <ImagePlus className="w-3.5 h-3.5" />}
            {regenState === 'working'
              ? regenProgress
              : regenState === 'done'
                ? t('settings.storage.done')
                : regenState === 'partial'
                  ? t('settings.storage.partial')
                  : t('settings.storage.regenerate')}
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">{t('settings.storage.deleteProxies')}</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings.storage.deleteProxiesDescription')}
            </p>
            {proxyFeedback && (
              <p
                className={cn(
                  'mt-1 text-xs',
                  proxyFeedback.tone === 'error' ? 'text-amber-400' : 'text-muted-foreground',
                )}
              >
                {proxyFeedback.message}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-28 gap-1.5"
            onClick={handleClearProxies}
            disabled={proxyState !== 'idle'}
          >
            {proxyState === 'clearing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {proxyState === 'done' && <Check className="w-3.5 h-3.5" />}
            {proxyState === 'partial' && <TriangleAlert className="w-3.5 h-3.5" />}
            {proxyState === 'idle' && <Film className="w-3.5 h-3.5" />}
            {proxyState === 'clearing'
              ? t('settings.storage.deleting')
              : proxyState === 'done'
                ? t('settings.storage.deleted')
                : proxyState === 'partial'
                  ? t('settings.storage.partial')
                  : t('settings.storage.delete')}
          </Button>
        </div>
        <Separator className="bg-white/8" />
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm">{t('settings.storage.localAi')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.storage.localAiDescription')}
            </p>
          </div>
          <LocalInferenceUnloadControl />
          <LocalModelCacheControl />
        </div>
      </div>

      <AlertDialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.storage.clearCacheConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.storage.clearCacheConfirmDescription', { count: mediaItems.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.storage.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void handleClearCache()
              }}
            >
              {t('settings.storage.clearCache')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
