import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Slider } from '@/components/ui/slider'
import { useSetCoverToCompoundsDialogStore } from '@/app/state/set-cover-to-compounds-dialog'
import { createLogger } from '@/shared/logging/logger'

import { COVER_DURATION_BOUNDS } from '../constants'
import {
  mediaLibraryService,
  resolveMediaUrl,
  useCompositionsStore,
  useMediaLibraryStore,
} from '../deps/timeline'
import { insertCover } from '../insert-cover-action'

const logger = createLogger('CompoundCover:SetCoverToCompoundsDialog')

export function SetCoverToCompoundsDialog() {
  const { t } = useTranslation()
  const isOpen = useSetCoverToCompoundsDialogStore((s) => s.isOpen)
  const source = useSetCoverToCompoundsDialogStore((s) => s.source)
  const close = useSetCoverToCompoundsDialogStore((s) => s.close)

  const compositions = useCompositionsStore((s) => s.compositions)
  const showNotification = useMediaLibraryStore((s) => s.showNotification)
  const currentProjectId = useMediaLibraryStore((s) => s.currentProjectId)

  const [title, setTitle] = useState('')
  const [durationSec, setDurationSec] = useState<number>(COVER_DURATION_BOUNDS.default)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Reset on (re)open.
  useEffect(() => {
    if (!isOpen) return
    setTitle('')
    setDurationSec(COVER_DURATION_BOUNDS.default)
    setSelectedIds(new Set())
    setFilter('')
    setSubmitting(false)
    setErrorMessage(null)
  }, [isOpen])

  const filteredCompositions = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return compositions
    return compositions.filter((comp) => comp.name.toLowerCase().includes(needle))
  }, [compositions, filter])

  const filteredIds = useMemo(() => filteredCompositions.map((c) => c.id), [filteredCompositions])

  const selectedFilteredCount = useMemo(
    () => filteredIds.reduce((acc, id) => acc + (selectedIds.has(id) ? 1 : 0), 0),
    [filteredIds, selectedIds],
  )

  const allFilteredSelected = filteredIds.length > 0 && selectedFilteredCount === filteredIds.length
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        for (const id of filteredIds) next.delete(id)
      } else {
        for (const id of filteredIds) next.add(id)
      }
      return next
    })
  }, [allFilteredSelected, filteredIds])

  const previewUrl = source?.kind === 'media-library' ? source.src : source?.objectUrl

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting && !next) return
      if (!next) close()
    },
    [submitting, close],
  )

  const handleSubmit = useCallback(async () => {
    if (!source) return
    if (selectedIds.size === 0) return
    setSubmitting(true)
    setErrorMessage(null)

    try {
      let frameMediaId: string
      let frameSrc: string
      let frameWidth: number
      let frameHeight: number

      if (source.kind === 'media-library') {
        frameMediaId = source.mediaId
        frameSrc = source.src
        frameWidth = source.width
        frameHeight = source.height
      } else {
        if (!currentProjectId) {
          throw new Error(t('compoundCover.setCoverToCompounds.noProjectError'))
        }
        const subtype =
          (source.file.type || 'image/png').split('/')[1]?.split(';')[0]?.trim() ?? 'png'
        const media = await mediaLibraryService.importGeneratedImage(
          source.file,
          currentProjectId,
          {
            width: source.width,
            height: source.height,
            tags: source.tags ? [...source.tags] : ['ai-generated', 'compound-cover:bulk'],
            codec: subtype,
          },
        )
        frameMediaId = media.id
        frameSrc = await resolveMediaUrl(media.id)
        frameWidth = media.width
        frameHeight = media.height
      }

      const ids = Array.from(selectedIds)
      const trimmedTitle = title.trim()
      let ok = 0
      let failed = 0
      for (const compositionId of ids) {
        try {
          insertCover({
            compositionId,
            durationSec,
            frameMediaId,
            frameSrc,
            frameWidth,
            frameHeight,
            primary: trimmedTitle,
          })
          ok++
        } catch (err) {
          failed++
          logger.error('Bulk insert cover failed for composition', { compositionId, err })
        }
      }

      const failedSuffix =
        failed > 0 ? t('compoundCover.setCoverToCompounds.failedSuffix', { failed }) : ''
      showNotification({
        type: failed > 0 ? 'warning' : 'success',
        message: t('compoundCover.setCoverToCompounds.bulkInsertNotification', {
          ok,
          total: ids.length,
          failedSuffix,
        }),
      })
      close()
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : t('compoundCover.setCoverToCompounds.setCoverFailed'),
      )
    } finally {
      setSubmitting(false)
    }
  }, [close, currentProjectId, durationSec, selectedIds, showNotification, source, t, title])

  if (!isOpen || !source) return null

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange} modal>
      <DialogContent
        className="sm:max-w-2xl"
        hideCloseButton={submitting}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (submitting) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('compoundCover.setCoverToCompounds.title')}</DialogTitle>
          <DialogDescription>
            {t('compoundCover.setCoverToCompounds.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-3">
            {previewUrl ? (
              <div
                className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-secondary/40"
                aria-label={t('compoundCover.setCoverToCompounds.coverImagePreviewAriaLabel')}
              >
                <img
                  src={previewUrl}
                  alt={t('compoundCover.setCoverToCompounds.coverPreviewAlt')}
                  className="block h-full w-full object-cover"
                />
              </div>
            ) : null}
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('compoundCover.setCoverToCompounds.titleLabel')}
              </Label>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('compoundCover.setCoverToCompounds.titlePlaceholder')}
                disabled={submitting}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('compoundCover.setCoverToCompounds.titleHint')}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('compoundCover.setCoverToCompounds.durationLabel')}
              </Label>
              <span className="text-xs text-muted-foreground">{durationSec.toFixed(1)} s</span>
            </div>
            <Slider
              min={COVER_DURATION_BOUNDS.min}
              max={COVER_DURATION_BOUNDS.max}
              step={COVER_DURATION_BOUNDS.step}
              value={[durationSec]}
              onValueChange={(values) => {
                const next = values[0]
                if (typeof next === 'number') {
                  setDurationSec(Math.round(next * 10) / 10)
                }
              }}
              aria-label={t('compoundCover.setCoverToCompounds.coverDurationAriaLabel')}
              disabled={submitting}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('compoundCover.setCoverToCompounds.targetCompoundsLabel')}
              </Label>
              <span className="text-[11px] text-muted-foreground">
                {t('compoundCover.setCoverToCompounds.selectedCount', { count: selectedIds.size })}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t('compoundCover.setCoverToCompounds.searchPlaceholder')}
                  className="pl-7"
                  disabled={submitting}
                />
              </div>
              <label
                className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-xs cursor-pointer select-none"
                aria-label={t('compoundCover.setCoverToCompounds.selectAllAriaLabel')}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                  checked={allFilteredSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someFilteredSelected
                  }}
                  onChange={toggleSelectAll}
                  disabled={submitting || filteredIds.length === 0}
                />
                {t('compoundCover.setCoverToCompounds.selectAll')}
              </label>
            </div>

            <ScrollArea className="h-56 rounded-md border border-border bg-secondary/20">
              {filteredCompositions.length === 0 ? (
                <div className="flex h-56 items-center justify-center px-3 text-center text-xs text-muted-foreground">
                  {compositions.length === 0
                    ? t('compoundCover.setCoverToCompounds.noCompoundsYet')
                    : t('compoundCover.setCoverToCompounds.noCompoundsMatch')}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {filteredCompositions.map((comp) => {
                    const checked = selectedIds.has(comp.id)
                    const seconds = comp.fps > 0 ? comp.durationInFrames / comp.fps : 0
                    return (
                      <li key={comp.id}>
                        <label className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-secondary/50 cursor-pointer">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                            checked={checked}
                            onChange={() => toggleOne(comp.id)}
                            disabled={submitting}
                          />
                          <span className="min-w-0 flex-1 truncate" title={comp.name}>
                            {comp.name}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {seconds.toFixed(1)}s · {comp.width}×{comp.height}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </ScrollArea>
          </div>

          {errorMessage ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {t('compoundCover.setCoverToCompounds.cancel')}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || selectedIds.size === 0}
          >
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {submitting
              ? t('compoundCover.setCoverToCompounds.setting')
              : t('compoundCover.setCoverToCompounds.setCoverWithCount', {
                  count: selectedIds.size,
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
