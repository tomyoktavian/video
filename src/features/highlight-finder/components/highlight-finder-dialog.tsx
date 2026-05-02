import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles, Square } from 'lucide-react'

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

import { useCustomAiStore, useSettingsStore } from '../deps/settings-contract'
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
  const isOpen = useHighlightFinderDialogStore((s) => s.isOpen)
  const selectedItemIds = useHighlightFinderDialogStore((s) => s.selectedItemIds)
  const close = useHighlightFinderDialogStore((s) => s.close)

  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const subtitleGranularity = useSettingsStore((s) => s.defaultSubtitleGranularity)
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
    setProgressLabel('Asking the model for highlights…')

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
            ? `${prepared.skippedComps} composition clip${prepared.skippedComps === 1 ? '' : 's'} skipped (not yet supported).`
            : prepared.returnedHighlights === 0
              ? 'The model returned no highlights. Try a different prompt or check your Custom AI settings.'
              : `The model returned ${prepared.returnedHighlights} highlight${prepared.returnedHighlights === 1 ? '' : 's'} but none could be mapped to the selected clips. Check the browser console for details.`
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
          granularity: subtitleGranularity,
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
          for (const t of tracksToAdd) {
            if (!workingTracks.some((wt) => wt.id === t.id)) {
              allTracksToAdd.push(t)
              workingTracks.push(t)
            }
          }
          workingItems.push(...textItems)
        }
      }

      const textTrackIds = new Set(allTracksToAdd.map((t) => t.id))
      if (allTracksToAdd.length > 0) {
        useTimelineStore
          .getState()
          .setTracks([...useTimelineStore.getState().tracks, ...allTracksToAdd])
      }
      if (allTextItems.length > 0) {
        useTimelineStore.getState().addItems(allTextItems)
      }

      setProgressLabel('Splitting clips and creating compound clips…')
      const result = applyHighlightPlans(prepared.plans, companionItemIdsByPlanIndex)

      if (textTrackIds.size > 0) {
        const currentItems = useTimelineStore.getState().items
        const tracksWithItems = new Set(currentItems.map((item) => item.trackId))
        useTimelineStore
          .getState()
          .setTracks(
            useTimelineStore
              .getState()
              .tracks.filter((t) => !textTrackIds.has(t.id) || tracksWithItems.has(t.id)),
          )
      }

      const summaryParts: string[] = []
      summaryParts.push(
        `Created ${result.compIds.length} highlight${result.compIds.length === 1 ? '' : 's'}.`,
      )
      if (prepared.skippedHighlights > 0) {
        summaryParts.push(`${prepared.skippedHighlights} skipped (out of bounds or too short).`)
      }
      if (prepared.skippedComps > 0) {
        summaryParts.push(`${prepared.skippedComps} composition clips skipped.`)
      }
      if (result.failed > 0) {
        summaryParts.push(`${result.failed} could not be wrapped.`)
      }

      showNotification({
        type: result.compIds.length > 0 ? 'success' : 'warning',
        message: summaryParts.join(' '),
      })

      close()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setErrorMessage('Cancelled.')
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to find highlights')
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
          <DialogTitle>Find Highlights</DialogTitle>
          <DialogDescription>
            Pick the most engaging moments from the selected clips and wrap each as a compound clip.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!customConfigured && (
            <p
              role="alert"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            >
              Configure base URL, API key, and model in Settings → AI → Custom AI → Vision Analyzer
              before running.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">Clip duration (s)</Label>
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
                Number of highlights{' '}
                {maxAllowedCount > 0 ? (
                  <span className="text-muted-foreground">(max {maxAllowedCount})</span>
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
              From {totalSelectedDurationSec.toFixed(0)}s of source you can fit up to{' '}
              <span className="text-foreground">{maxAllowedCount}</span> clip
              {maxAllowedCount === 1 ? '' : 's'} of {clipDuration.toFixed(0)}s each. Picking{' '}
              <span className="text-foreground">{targetCount}</span> (~
              {projectedTotalSec.toFixed(0)}s total).
            </p>
          ) : clipDurationValid && totalSelectedDurationSec > 0 && maxAllowedCount === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Selected clips total {totalSelectedDurationSec.toFixed(0)}s — too short for even one{' '}
              {clipDuration.toFixed(0)}s clip. Reduce <strong>Clip duration</strong>.
            </p>
          ) : null}

          <div className="flex items-center justify-between py-0.5">
            <Label htmlFor="add-subtitles-switch" className="text-sm cursor-pointer">
              Add subtitles
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
              Compound clip name language
            </Label>
            <Combobox
              value={titleLanguage}
              onValueChange={setTitleLanguage}
              options={WHISPER_LANGUAGE_OPTIONS}
              placeholder="Auto-detect from source"
              searchPlaceholder="Search languages..."
              emptyMessage="No languages match that search."
              disabled={isRunning}
            />
            <p className="text-xs text-muted-foreground">
              AI writes the compound clip name (used as its title) in this language regardless of
              the source. Subtitles always stay in the source language.
            </p>
          </div>

          {summary.length > 0 ? (
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs space-y-1">
              <p className="text-muted-foreground">
                {summary.length} clip{summary.length === 1 ? '' : 's'} selected ·{' '}
                {totalSelectedDurationSec.toFixed(1)}s total · {clipsWithContext} of{' '}
                {summary.length} have captions and transcript
              </p>
              <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                {summary.map((entry) => (
                  <li key={entry.itemId} className="flex items-center gap-1.5">
                    <span className="truncate text-foreground">{entry.fileName}</span>
                    <span className="shrink-0 text-muted-foreground">
                      ({entry.durationSec.toFixed(1)}s
                      {entry.hasContext ? '' : ', missing captions or transcript'})
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
              No eligible clips selected. Highlight Finder works on video or audio clips that have
              both AI captions and a transcript.
            </p>
          )}

          {summary.length > 0 && clipsWithContext === 0 && (
            <p className="text-xs text-muted-foreground">
              None of the selected clips have both captions and a transcript. Run{' '}
              <strong>Analyze with AI</strong> and <strong>Generate Transcript</strong> first.
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
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
              <Button onClick={() => void handleStart()} disabled={!canRun}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                Find Highlights
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
