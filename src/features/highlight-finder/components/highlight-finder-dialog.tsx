import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles, Square } from 'lucide-react'
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
import { Combobox } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  WHISPER_AUTO_LANGUAGE_VALUE,
  WHISPER_LANGUAGE_OPTIONS,
} from '@/shared/utils/whisper-settings'
import { useEditorStore } from '@/app/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import { useHighlightFinderDialogStore } from '@/app/state/highlight-finder-dialog'

import { useCustomAiStore } from '../deps/settings-contract'
import { useTimelineStore } from '../deps/timeline'
import { useMediaLibraryStore } from '../deps/media-library'
import { applyHighlightPlans } from '../deps/timeline-actions'
import { getCanvasSize } from '../deps/project'
import { prepareHighlights } from '../highlight-finder-service'
import { buildHighlightTextItems } from '../build-highlight-text-items'

const DEFAULT_TARGET_COUNT = 5
const DEFAULT_CLIP_DURATION_SEC = 180
/**
 * Hard cap on the dialog's "Number of highlights" input. The actual upper
 * bound shown to the user is `min(this, floor(totalSelectedDuration / clipDuration))`
 * so the user can never request more highlights than the source material
 * supports.
 */
const TARGET_COUNT_HARD_MAX = 50
const CLIP_DURATION_BOUNDS = { min: 1, max: 600 }

interface SelectedClipSummary {
  itemId: string
  fileName: string
  durationSec: number
  hasContext: boolean
}

export function HighlightFinderDialog() {
  const { t } = useTranslation()
  const isOpen = useHighlightFinderDialogStore((s) => s.isOpen)
  const selectedItemIds = useHighlightFinderDialogStore((s) => s.selectedItemIds)
  const close = useHighlightFinderDialogStore((s) => s.close)

  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const items = useTimelineStore((s) => s.items)
  const fps = useTimelineStore((s) => s.fps)
  const mediaById = useMediaLibraryStore((s) => s.mediaById)
  const transcriptStatus = useMediaLibraryStore((s) => s.transcriptStatus)
  const showNotification = useMediaLibraryStore((s) => s.showNotification)
  const beginTranscriptionDialog = useEditorStore((s) => s.beginTranscriptionDialog)
  const endTranscriptionDialog = useEditorStore((s) => s.endTranscriptionDialog)

  const [targetCount, setTargetCount] = useState<number>(DEFAULT_TARGET_COUNT)
  const [clipDuration, setClipDuration] = useState<number>(DEFAULT_CLIP_DURATION_SEC)
  const [addSubtitles, setAddSubtitles] = useState(true)
  const [titleLanguage, setTitleLanguage] = useState<string>(WHISPER_AUTO_LANGUAGE_VALUE)
  const [isRunning, setIsRunning] = useState(false)
  const [progressLabel, setProgressLabel] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Reset state when dialog opens.
  useEffect(() => {
    if (!isOpen) return
    setTargetCount(DEFAULT_TARGET_COUNT)
    setClipDuration(DEFAULT_CLIP_DURATION_SEC)
    setTitleLanguage(WHISPER_AUTO_LANGUAGE_VALUE)
    setErrorMessage(null)
    setProgressLabel('')
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    beginTranscriptionDialog()
    usePlaybackStore.getState().setPreviewFrame(null)
    usePlaybackStore.getState().pause()
    return () => {
      endTranscriptionDialog()
    }
  }, [beginTranscriptionDialog, endTranscriptionDialog, isOpen])

  const summary = useMemo<SelectedClipSummary[]>(() => {
    if (!isOpen) return []
    const result: SelectedClipSummary[] = []
    for (const id of selectedItemIds) {
      const item = items.find((entry) => entry.id === id)
      if (!item) continue
      if (item.type === 'composition') continue
      if (item.type !== 'video' && item.type !== 'audio') continue
      if (!item.mediaId) continue
      const media = mediaById[item.mediaId]
      if (!media) continue
      const durationSec = item.durationInFrames / Math.max(1, fps)
      const hasCaptions = (media.aiCaptions?.length ?? 0) > 0
      const hasTranscript = transcriptStatus.get(item.mediaId) === 'ready'
      result.push({
        itemId: item.id,
        fileName: media.fileName,
        durationSec,
        hasContext: hasCaptions && hasTranscript,
      })
    }
    return result
  }, [isOpen, items, selectedItemIds, mediaById, transcriptStatus, fps])

  const totalSelectedDurationSec = useMemo(
    () => summary.reduce((sum, entry) => sum + entry.durationSec, 0),
    [summary],
  )
  const clipsWithContext = summary.filter((entry) => entry.hasContext).length

  const customConfigured = Boolean(
    visionAnalyzer.baseUrl && visionAnalyzer.apiKey && visionAnalyzer.model,
  )
  const noEligibleClips = summary.length === 0 || clipsWithContext === 0
  const clipDurationValid =
    Number.isFinite(clipDuration) &&
    clipDuration >= CLIP_DURATION_BOUNDS.min &&
    clipDuration <= CLIP_DURATION_BOUNDS.max

  // Derive the upper bound for "Number of highlights" from the selected
  // material and the chosen clip duration.
  const maxAllowedCount = useMemo(() => {
    if (!clipDurationValid || clipDuration <= 0) return 0
    if (totalSelectedDurationSec <= 0) return 0
    return Math.min(TARGET_COUNT_HARD_MAX, Math.floor(totalSelectedDurationSec / clipDuration))
  }, [clipDurationValid, clipDuration, totalSelectedDurationSec])

  // Auto-clamp the chosen count whenever the upper bound shrinks.
  useEffect(() => {
    if (maxAllowedCount === 0) return
    if (targetCount > maxAllowedCount) setTargetCount(maxAllowedCount)
    else if (targetCount < 1) setTargetCount(1)
  }, [maxAllowedCount, targetCount])

  const targetCountValid =
    Number.isFinite(targetCount) && targetCount >= 1 && targetCount <= maxAllowedCount

  const projectedTotalSec = (Number.isFinite(targetCount) ? targetCount : 0) * clipDuration

  const canRun =
    !isRunning &&
    customConfigured &&
    !noEligibleClips &&
    targetCountValid &&
    clipDurationValid &&
    maxAllowedCount > 0

  const handleStart = useCallback(async () => {
    if (!canRun) return
    setErrorMessage(null)
    setIsRunning(true)
    setProgressLabel(t('highlightFinder.dialog.progressAsking'))

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const prepared = await prepareHighlights({
        selectedItemIds,
        targetCount,
        clipDurationSec: clipDuration,
        ...(titleLanguage && titleLanguage !== WHISPER_AUTO_LANGUAGE_VALUE
          ? { titleLanguage }
          : {}),
        signal: controller.signal,
      })

      if (prepared.plans.length === 0) {
        const reason =
          prepared.skippedComps > 0
            ? `${prepared.skippedComps} ${prepared.skippedComps === 1 ? t('highlightFinder.dialog.compositionClipSkipped') : t('highlightFinder.dialog.compositionClipsSkipped')}`
            : prepared.returnedHighlights === 0
              ? t('highlightFinder.dialog.noHighlightsReturned')
              : `${t('highlightFinder.dialog.modelReturnedPrefix')} ${prepared.returnedHighlights} ${prepared.returnedHighlights === 1 ? t('highlightFinder.dialog.highlightSuffix') : t('highlightFinder.dialog.highlightsSuffix')} ${t('highlightFinder.dialog.noneMappedSuffix')}`
        setErrorMessage(reason)
        setIsRunning(false)
        return
      }

      // Pre-create text items at absolute main-timeline positions, then pass
      // as companion IDs to createPreComp so they end up inside each compound clip.
      const { width: canvasWidth, height: canvasHeight } = getCanvasSize()
      const workingTracks = [...useTimelineStore.getState().tracks]
      const workingItems = [...useTimelineStore.getState().items]
      const companionItemIdsByPlanIndex = new Map<number, string[]>()
      const allTextItems: ReturnType<typeof buildHighlightTextItems>['textItems'] = []
      const allTracksToAdd: ReturnType<typeof buildHighlightTextItems>['tracksToAdd'] = []

      for (let i = 0; i < prepared.plans.length; i++) {
        const plan = prepared.plans[i]
        if (!plan) continue
        const context = prepared.contexts.find((c) => c.itemId === plan.itemId)
        if (!context) continue
        const { textItems, tracksToAdd } = buildHighlightTextItems({
          plan,
          context,
          addSubtitles,
          canvasWidth,
          canvasHeight,
          existingTracks: workingTracks,
          existingItems: workingItems,
        })
        if (textItems.length > 0) {
          companionItemIdsByPlanIndex.set(
            i,
            textItems.map((item) => item.id),
          )
          allTextItems.push(...textItems)
          for (const track of tracksToAdd) {
            if (!workingTracks.some((wt) => wt.id === track.id)) {
              allTracksToAdd.push(track)
              workingTracks.push(track)
            }
          }
          workingItems.push(...textItems)
        }
      }

      const textTrackIds = new Set(allTracksToAdd.map((track) => track.id))
      if (allTracksToAdd.length > 0) {
        useTimelineStore
          .getState()
          .setTracks([...useTimelineStore.getState().tracks, ...allTracksToAdd])
      }
      if (allTextItems.length > 0) {
        useTimelineStore.getState().addItems(allTextItems)
      }

      setProgressLabel(t('highlightFinder.dialog.progressSplitting'))
      const result = applyHighlightPlans(prepared.plans, companionItemIdsByPlanIndex)

      if (textTrackIds.size > 0) {
        const currentItems = useTimelineStore.getState().items
        const tracksWithItems = new Set(currentItems.map((item) => item.trackId))
        useTimelineStore
          .getState()
          .setTracks(
            useTimelineStore
              .getState()
              .tracks.filter(
                (track) => !textTrackIds.has(track.id) || tracksWithItems.has(track.id),
              ),
          )
      }

      const summaryParts: string[] = []
      summaryParts.push(
        `${t('highlightFinder.dialog.createdPrefix')} ${result.compIds.length} ${result.compIds.length === 1 ? t('highlightFinder.dialog.highlightSuffix') : t('highlightFinder.dialog.highlightsSuffix')}.`,
      )
      if (prepared.skippedHighlights > 0) {
        summaryParts.push(
          `${prepared.skippedHighlights} ${t('highlightFinder.dialog.skippedOutOfBounds')}`,
        )
      }
      if (prepared.skippedComps > 0) {
        summaryParts.push(
          `${prepared.skippedComps} ${t('highlightFinder.dialog.compositionClipsSkippedShort')}`,
        )
      }
      if (result.failed > 0) {
        summaryParts.push(`${result.failed} ${t('highlightFinder.dialog.couldNotWrap')}`)
      }

      showNotification({
        type: result.compIds.length > 0 ? 'success' : 'warning',
        message: summaryParts.join(' '),
      })

      close()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setErrorMessage(t('highlightFinder.dialog.cancelled'))
      } else {
        setErrorMessage(
          error instanceof Error ? error.message : t('highlightFinder.dialog.failedToFind'),
        )
      }
    } finally {
      abortRef.current = null
      setIsRunning(false)
      setProgressLabel('')
    }
  }, [
    canRun,
    selectedItemIds,
    targetCount,
    clipDuration,
    addSubtitles,
    titleLanguage,
    showNotification,
    close,
    t,
  ])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (isRunning && !next) return
      if (!next) close()
    },
    [isRunning, close],
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange} modal>
      <DialogContent
        className="sm:max-w-lg"
        hideCloseButton={isRunning}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (isRunning) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('highlightFinder.dialog.title')}</DialogTitle>
          <DialogDescription>{t('highlightFinder.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!customConfigured && (
            <p
              role="alert"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            >
              {t('highlightFinder.dialog.configureCustomAi')}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">{t('highlightFinder.dialog.clipDurationLabel')}</Label>
              <Input
                type="number"
                inputMode="decimal"
                min={CLIP_DURATION_BOUNDS.min}
                max={CLIP_DURATION_BOUNDS.max}
                step={1}
                value={Number.isFinite(clipDuration) ? clipDuration : ''}
                onChange={(event) => {
                  const parsed = Number(event.target.value)
                  setClipDuration(Number.isFinite(parsed) ? parsed : NaN)
                }}
                disabled={isRunning}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">
                {t('highlightFinder.dialog.numberOfHighlightsLabel')}{' '}
                {maxAllowedCount > 0 ? (
                  <span className="text-muted-foreground">
                    ({t('highlightFinder.dialog.maxPrefix')} {maxAllowedCount})
                  </span>
                ) : null}
              </Label>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={Math.max(1, maxAllowedCount)}
                step={1}
                value={Number.isFinite(targetCount) ? targetCount : ''}
                onChange={(event) => {
                  const parsed = Number(event.target.value)
                  if (!Number.isFinite(parsed)) {
                    setTargetCount(NaN)
                    return
                  }
                  const rounded = Math.round(parsed)
                  // Clamp on input so the user can't type a value > maxAllowedCount.
                  if (maxAllowedCount > 0) {
                    setTargetCount(Math.min(Math.max(1, rounded), maxAllowedCount))
                  } else {
                    setTargetCount(rounded)
                  }
                }}
                disabled={isRunning || maxAllowedCount === 0}
              />
            </div>
          </div>

          {clipDurationValid && maxAllowedCount > 0 && targetCountValid ? (
            <p className="text-xs text-muted-foreground">
              {t('highlightFinder.dialog.fromSourcePrefix')} {totalSelectedDurationSec.toFixed(0)}
              {t('highlightFinder.dialog.sourceCanFit')}{' '}
              <span className="text-foreground">{maxAllowedCount}</span>{' '}
              {maxAllowedCount === 1
                ? t('highlightFinder.dialog.clipSingular')
                : t('highlightFinder.dialog.clipPlural')}{' '}
              {t('highlightFinder.dialog.ofDuration')} {clipDuration.toFixed(0)}
              {t('highlightFinder.dialog.eachPicking')}{' '}
              <span className="text-foreground">{targetCount}</span> (~
              {projectedTotalSec.toFixed(0)}
              {t('highlightFinder.dialog.totalSuffix')}).
            </p>
          ) : clipDurationValid && totalSelectedDurationSec > 0 && maxAllowedCount === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('highlightFinder.dialog.selectedClipsTotal')} {totalSelectedDurationSec.toFixed(0)}
              {t('highlightFinder.dialog.tooShortFor')} {clipDuration.toFixed(0)}
              {t('highlightFinder.dialog.clipReduce')}{' '}
              <strong>{t('highlightFinder.dialog.clipDurationStrong')}</strong>.
            </p>
          ) : null}

          <div className="flex items-center justify-between py-0.5">
            <Label htmlFor="add-subtitles-switch" className="text-sm cursor-pointer">
              {t('highlightFinder.dialog.addSubtitles')}
            </Label>
            <Switch
              id="add-subtitles-switch"
              checked={addSubtitles}
              onCheckedChange={setAddSubtitles}
              disabled={isRunning}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('highlightFinder.dialog.compoundClipLanguageLabel')}
            </Label>
            <Combobox
              value={titleLanguage}
              onValueChange={setTitleLanguage}
              options={WHISPER_LANGUAGE_OPTIONS}
              placeholder={t('highlightFinder.dialog.autoDetectPlaceholder')}
              searchPlaceholder={t('highlightFinder.dialog.searchLanguagesPlaceholder')}
              emptyMessage={t('highlightFinder.dialog.noLanguagesMatch')}
              disabled={isRunning}
            />
            <p className="text-xs text-muted-foreground">
              {t('highlightFinder.dialog.compoundClipLanguageHint')}
            </p>
          </div>

          {summary.length > 0 ? (
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs space-y-1">
              <p className="text-muted-foreground">
                {summary.length}{' '}
                {summary.length === 1
                  ? t('highlightFinder.dialog.clipSingular')
                  : t('highlightFinder.dialog.clipPlural')}{' '}
                {t('highlightFinder.dialog.selectedDot')} {totalSelectedDurationSec.toFixed(1)}
                {t('highlightFinder.dialog.totalDot')} {clipsWithContext}{' '}
                {t('highlightFinder.dialog.ofPrefix')} {summary.length}{' '}
                {t('highlightFinder.dialog.haveCaptionsAndTranscript')}
              </p>
              <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                {summary.map((entry) => (
                  <li key={entry.itemId} className="flex items-center gap-1.5">
                    <span className="truncate text-foreground">{entry.fileName}</span>
                    <span className="shrink-0 text-muted-foreground">
                      ({entry.durationSec.toFixed(1)}s
                      {entry.hasContext
                        ? ''
                        : t('highlightFinder.dialog.missingCaptionsOrTranscript')}
                      )
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p
              role="alert"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            >
              {t('highlightFinder.dialog.noEligibleClips')}
            </p>
          )}

          {summary.length > 0 && clipsWithContext === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('highlightFinder.dialog.noneHaveBothPrefix')}{' '}
              <strong>{t('highlightFinder.dialog.analyzeWithAi')}</strong>{' '}
              {t('highlightFinder.dialog.and')}{' '}
              <strong>{t('highlightFinder.dialog.generateTranscript')}</strong>{' '}
              {t('highlightFinder.dialog.firstSuffix')}.
            </p>
          )}

          {errorMessage && !isRunning && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {errorMessage}
            </div>
          )}

          {isRunning && (
            <div className="space-y-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="truncate">{progressLabel}</span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {isRunning ? (
            <Button variant="destructive" onClick={handleCancel}>
              <Square className="mr-1.5 h-3.5 w-3.5" />
              {t('highlightFinder.dialog.cancel')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('highlightFinder.dialog.close')}
              </Button>
              <Button onClick={() => void handleStart()} disabled={!canRun}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {t('highlightFinder.dialog.findHighlights')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
