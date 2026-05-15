import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
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
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAddCoverDialogStore } from '@/app/state/add-cover-dialog'

import { COVER_DURATION_BOUNDS } from '../constants'
import { useCustomAiStore } from '../deps/settings'
import { useCompositionsStore, useMediaLibraryStore } from '../deps/timeline'
import { gatherCoverFormDefaults, generateCoverText } from '../cover-service'
import { persistCoverFrame, renderCoverFrame } from '../frame-extraction'
import { insertCover } from '../insert-cover-action'
import type { CoverTextSuggestion } from '../types'

import { AiImagePanel, type AiImageGeneratedPayload } from './ai-image-panel'
import { pickAspectRatioFromCanvas } from './aspect-ratio-options'
import { FramePicker } from './frame-picker'

type TextMode = 'transcript' | 'manual-prompt' | 'manual-text'
type FrameSource = 'frame' | 'ai'

export function AddCoverDialog() {
  const { t } = useTranslation()
  const isOpen = useAddCoverDialogStore((s) => s.isOpen)
  const compositionId = useAddCoverDialogStore((s) => s.compositionId)
  const close = useAddCoverDialogStore((s) => s.close)

  const composition = useCompositionsStore((s) =>
    compositionId ? s.compositionById[compositionId] : undefined,
  )
  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const imageGenerator = useCustomAiStore((s) => s.imageGenerator)
  const showNotification = useMediaLibraryStore((s) => s.showNotification)

  const [frameSource, setFrameSource] = useState<FrameSource>('frame')
  const [selectedFrame, setSelectedFrame] = useState<number>(0)
  const [textMode, setTextMode] = useState<TextMode>('transcript')
  const [manualPrompt, setManualPrompt] = useState('')
  const [primary, setPrimary] = useState('')
  const [accent, setAccent] = useState('')
  const [secondary, setSecondary] = useState('')
  const [durationSec, setDurationSec] = useState<number>(COVER_DURATION_BOUNDS.default)

  const [suggestions, setSuggestions] = useState<readonly CoverTextSuggestion[]>([])
  const [generating, setGenerating] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Title + transcript stay in parent state so the async prefill effect can
  // populate them once `gatherCoverFormDefaults` resolves. Aspect / taste
  // fields default purely from the project canvas, so the AiImagePanel
  // owns them via `initialValues`.
  const [aiTitle, setAiTitle] = useState('')
  const [aiTranscript, setAiTranscript] = useState('')
  const [aiInitialAspect, setAiInitialAspect] = useState<string>('auto')
  /** Bumped on dialog open so AiImagePanel remounts with fresh defaults. */
  const [aiPanelKey, setAiPanelKey] = useState(0)

  const [aiImageBlob, setAiImageBlob] = useState<Blob | null>(null)

  const generateAbortRef = useRef<AbortController | null>(null)

  // Reset dialog state every time it (re)opens.
  useEffect(() => {
    if (!isOpen) return
    setFrameSource('frame')
    setSelectedFrame(0)
    setTextMode('transcript')
    setManualPrompt('')
    setPrimary('')
    setAccent('')
    setSecondary('')
    setDurationSec(COVER_DURATION_BOUNDS.default)
    setSuggestions([])
    setErrorMessage(null)
    setAiTitle('')
    setAiTranscript('')
    setAiInitialAspect('auto')
    setAiImageBlob(null)
    setAiPanelKey((k) => k + 1)

    // Auto-fill the AI form fields with this compound's title, gathered
    // transcript, and canvas-derived aspect-ratio label so the user can
    // click "Generate image" right away. The fields remain editable but
    // are not persisted across dialog opens.
    if (!compositionId) return
    let cancelled = false
    void (async () => {
      try {
        const defaults = await gatherCoverFormDefaults(compositionId)
        if (cancelled) return
        setAiTitle(defaults.title)
        setAiTranscript(defaults.transcript)
        // Pre-select the dropdown option that matches the project canvas so
        // users don't have to guess the right ratio every time. Falls back to
        // 'auto' if the canvas doesn't match any canonical bucket within ~3%.
        setAiInitialAspect(pickAspectRatioFromCanvas(defaults.width, defaults.height))
        setAiPanelKey((k) => k + 1)
      } catch {
        // Silent miss — empty fields let the user type their own values.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOpen, compositionId])

  // Abort any pending suggestion request when the dialog closes.
  useEffect(() => {
    if (isOpen) return
    generateAbortRef.current?.abort()
    generateAbortRef.current = null
  }, [isOpen])

  const customConfigured = Boolean(
    visionAnalyzer.baseUrl && visionAnalyzer.apiKey && visionAnalyzer.model,
  )
  const imageGeneratorConfigured = Boolean(
    imageGenerator.baseUrl && imageGenerator.apiKey && imageGenerator.model,
  )

  const aiAvailable = textMode !== 'manual-text' && customConfigured

  const handleAiImageGenerated = useCallback((payload: AiImageGeneratedPayload) => {
    setAiImageBlob(payload.blob)
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!compositionId) return
    if (textMode === 'manual-text') return
    if (!customConfigured) {
      setErrorMessage(t('compoundCover.addCover.configureVisionAnalyzerError'))
      return
    }

    setGenerating(true)
    setErrorMessage(null)
    setSuggestions([])

    const controller = new AbortController()
    generateAbortRef.current = controller

    try {
      const result = await generateCoverText({
        mode: textMode,
        compositionId,
        prompt: manualPrompt,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setSuggestions(result.suggestions)
      const top = result.suggestions[0]
      if (top) {
        setPrimary(top.primary)
        setAccent(top.accent ?? '')
        setSecondary(top.secondary ?? '')
      } else {
        setErrorMessage(t('compoundCover.addCover.noSuggestionsError'))
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setErrorMessage(
        error instanceof Error ? error.message : t('compoundCover.addCover.generateTextFailed'),
      )
    } finally {
      if (generateAbortRef.current === controller) generateAbortRef.current = null
      setGenerating(false)
    }
  }, [compositionId, customConfigured, manualPrompt, textMode, t])

  const handleSuggestionClick = useCallback((suggestion: CoverTextSuggestion) => {
    setPrimary(suggestion.primary)
    setAccent(suggestion.accent ?? '')
    setSecondary(suggestion.secondary ?? '')
  }, [])

  const canInsert = useMemo(() => {
    if (!composition) return false
    if (inserting) return false
    if (durationSec < COVER_DURATION_BOUNDS.min || durationSec > COVER_DURATION_BOUNDS.max)
      return false
    if (frameSource === 'ai') {
      if (!aiImageBlob) return false
      return true
    }
    if (primary.trim().length === 0) return false
    return true
  }, [aiImageBlob, composition, durationSec, frameSource, inserting, primary])

  const handleInsert = useCallback(async () => {
    if (!compositionId || !composition) return
    setInserting(true)
    setErrorMessage(null)
    try {
      const isAiSource = frameSource === 'ai'
      const blob =
        isAiSource && aiImageBlob
          ? aiImageBlob
          : await renderCoverFrame(compositionId, selectedFrame, {
              width: composition.width,
              height: composition.height,
              quality: 0.92,
            })
      // Persist the chosen image as a real Media Library item. For AI covers
      // this also makes the generated poster available to drop onto the
      // timeline directly later — the file lives under the project's OPFS
      // storage (workspace-fs) with `ai-generated` + `compound-cover:ai` tags.
      const persisted = await persistCoverFrame(
        compositionId,
        blob,
        composition.width,
        composition.height,
        { source: isAiSource ? 'ai' : 'frame' },
      )
      const frameSrc = persisted.opfsPath
        ? `opfs://${persisted.opfsPath}`
        : URL.createObjectURL(blob)

      // AI-generated posters bake the title text into the image itself, so
      // we skip the Vlog overlay text items in that path.
      const result = insertCover({
        compositionId,
        durationSec,
        frameMediaId: persisted.id,
        frameSrc,
        frameWidth: composition.width,
        frameHeight: composition.height,
        primary: isAiSource ? '' : primary,
        accent: isAiSource ? '' : accent,
        secondary: isAiSource ? '' : secondary,
      })

      showNotification({
        type: 'success',
        message: t('compoundCover.addCover.coverAddedNotification', {
          frames: result.coverDurationFrames,
        }),
      })
      close()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('compoundCover.addCover.insertCoverFailed'),
      )
    } finally {
      setInserting(false)
    }
  }, [
    accent,
    aiImageBlob,
    close,
    composition,
    compositionId,
    durationSec,
    frameSource,
    primary,
    secondary,
    selectedFrame,
    showNotification,
    t,
  ])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (inserting && !next) return
      if (!next) close()
    },
    [inserting, close],
  )

  if (!compositionId || !composition) {
    return null
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange} modal>
      <DialogContent
        className="sm:max-w-2xl"
        hideCloseButton={inserting}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (inserting) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('compoundCover.addCover.title')}</DialogTitle>
          <DialogDescription>{t('compoundCover.addCover.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('compoundCover.addCover.coverImageLabel')}
            </Label>
            <Tabs
              value={frameSource}
              onValueChange={(value) => setFrameSource(value as FrameSource)}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="frame">{t('compoundCover.addCover.findFrameTab')}</TabsTrigger>
                <TabsTrigger value="ai">
                  {t('compoundCover.addCover.generateWithAiTab')}
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="frame"
                className="mt-2 h-[calc(85vh-220px)] min-h-[260px] overflow-y-auto"
              >
                <div className="space-y-4">
                  <FramePicker
                    compositionId={compositionId}
                    selectedFrame={selectedFrame}
                    onChange={setSelectedFrame}
                  />

                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                      {t('compoundCover.addCover.textLabel')}
                    </Label>
                    <Tabs
                      value={textMode}
                      onValueChange={(value) => setTextMode(value as TextMode)}
                    >
                      <TabsList className="grid w-full grid-cols-3">
                        <TabsTrigger value="transcript">
                          {t('compoundCover.addCover.fromTranscriptTab')}
                        </TabsTrigger>
                        <TabsTrigger value="manual-prompt">
                          {t('compoundCover.addCover.manualPromptTab')}
                        </TabsTrigger>
                        <TabsTrigger value="manual-text">
                          {t('compoundCover.addCover.typeMyselfTab')}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="transcript" className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {t('compoundCover.addCover.transcriptHint')}
                        </p>
                      </TabsContent>
                      <TabsContent value="manual-prompt" className="space-y-2">
                        <Textarea
                          value={manualPrompt}
                          onChange={(event) => setManualPrompt(event.target.value)}
                          placeholder={t('compoundCover.addCover.manualPromptPlaceholder')}
                          rows={2}
                          spellCheck={false}
                          className="resize-none text-sm"
                        />
                      </TabsContent>
                      <TabsContent value="manual-text" className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {t('compoundCover.addCover.manualTextHint')}
                        </p>
                      </TabsContent>
                    </Tabs>

                    {textMode !== 'manual-text' ? (
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void handleGenerate()}
                          disabled={!aiAvailable || generating || inserting}
                          className="shrink-0"
                        >
                          {generating ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {generating
                            ? t('compoundCover.addCover.generating')
                            : t('compoundCover.addCover.generate')}
                        </Button>
                        {!customConfigured ? (
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            {t('compoundCover.addCover.configureCustomAiHint')}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {suggestions.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {suggestions.map((suggestion, index) => (
                          <button
                            key={`${suggestion.primary}-${index}`}
                            type="button"
                            onClick={() => handleSuggestionClick(suggestion)}
                            className="rounded-full border border-border bg-secondary px-3 py-1 text-xs hover:border-primary/60 hover:bg-secondary/70"
                          >
                            {[suggestion.primary, suggestion.accent, suggestion.secondary]
                              .filter((part) => part && part.length > 0)
                              .join(' ')}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-xs">
                          {t('compoundCover.addCover.primaryLabel')}
                        </Label>
                        <Input
                          value={primary}
                          onChange={(event) => setPrimary(event.target.value)}
                          placeholder={t('compoundCover.addCover.primaryPlaceholder')}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t('compoundCover.addCover.accentLabel')}</Label>
                        <Input
                          value={accent}
                          onChange={(event) => setAccent(event.target.value)}
                          placeholder={t('compoundCover.addCover.accentPlaceholder')}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">
                          {t('compoundCover.addCover.secondaryLabel')}
                        </Label>
                        <Input
                          value={secondary}
                          onChange={(event) => setSecondary(event.target.value)}
                          placeholder={t('compoundCover.addCover.secondaryPlaceholder')}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>
              <TabsContent
                value="ai"
                className="mt-2 h-[calc(70vh-220px)] min-h-[260px] overflow-y-auto"
              >
                <AiImagePanel
                  key={aiPanelKey}
                  width={composition.width}
                  height={composition.height}
                  promptMode="split"
                  enableTranscriptSummarise
                  imageGeneratorConfigured={imageGeneratorConfigured}
                  imageGeneratorModel={imageGenerator.model}
                  imageGeneratorBaseUrl={imageGenerator.baseUrl}
                  visionAnalyzerConfigured={customConfigured}
                  controlledTitle={{ value: aiTitle, onChange: setAiTitle }}
                  controlledTranscript={{ value: aiTranscript, onChange: setAiTranscript }}
                  initialValues={{ aspect: aiInitialAspect }}
                  disabled={inserting}
                  downloadFilenamePrefix={`cover-ai-${compositionId.slice(0, 8)}`}
                  onImageGenerated={handleAiImageGenerated}
                />
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('compoundCover.addCover.durationLabel')}
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
              aria-label={t('compoundCover.addCover.coverDurationAriaLabel')}
            />
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
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={inserting}>
            {t('compoundCover.addCover.cancel')}
          </Button>
          <Button onClick={() => void handleInsert()} disabled={!canInsert}>
            {inserting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {inserting
              ? t('compoundCover.addCover.inserting')
              : t('compoundCover.addCover.insertCover')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
