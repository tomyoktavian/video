import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAddCoverDialogStore } from '@/app/state/add-cover-dialog'

import { useCustomAiStore } from '../deps/settings'
import { useCompositionsStore, useMediaLibraryStore } from '../deps/timeline'
import {
  buildCoverImagePromptFromForm,
  gatherCoverFormDefaults,
  generateCoverText,
  summariseCoverTranscript,
} from '../cover-service'
import { persistCoverFrame, renderCoverFrame } from '../frame-extraction'
import { generateCoverImage } from '../openai-compatible-image-adapter'
import { insertCover } from '../insert-cover-action'
import {
  POSTER_CAST_OPTIONS,
  POSTER_MOOD_OPTIONS,
  POSTER_QUALITY_OPTIONS,
  POSTER_STYLE_OPTIONS,
  resolvePosterQualityApiValue,
  type PosterCastValue,
  type PosterMoodValue,
  type PosterQualityValue,
  type PosterStyleValue,
} from '../system-prompt'
import type { CoverTextSuggestion } from '../types'

import { FramePicker } from './frame-picker'

const DEFAULT_COVER_DURATION_SEC = 0.5
const COVER_DURATION_MIN = 0.5
const COVER_DURATION_MAX = 5

type TextMode = 'transcript' | 'manual-prompt' | 'manual-text'
type FrameSource = 'frame' | 'ai'

interface AspectRatioOption {
  value: string
  label: string
  /**
   * Width:height pair used to draw the icon. `null` is the special "None /
   * Default" option — drawn as a dashed rectangle to signal "no constraint",
   * and substituted into the prompt as an empty aspect line.
   */
  dim: { w: number; h: number } | null
}

const ASPECT_RATIO_OPTIONS: ReadonlyArray<AspectRatioOption> = [
  { value: 'auto', label: 'None (Default)', dim: null },
  { value: '1:1', label: '1:1 (Square)', dim: { w: 1, h: 1 } },
  { value: '3:2', label: '3:2 (Landscape)', dim: { w: 3, h: 2 } },
  { value: '2:3', label: '2:3 (Portrait)', dim: { w: 2, h: 3 } },
  { value: '3:4', label: '3:4 (Portrait)', dim: { w: 3, h: 4 } },
  { value: '4:1', label: '4:1 (Panoramic)', dim: { w: 4, h: 1 } },
  { value: '4:3', label: '4:3 (Landscape)', dim: { w: 4, h: 3 } },
  { value: '4:5', label: '4:5 (Portrait)', dim: { w: 4, h: 5 } },
  { value: '5:4', label: '5:4 (Landscape)', dim: { w: 5, h: 4 } },
  { value: '8:1', label: '8:1 (Super-wide)', dim: { w: 8, h: 1 } },
  { value: '9:16', label: '9:16 (Portrait)', dim: { w: 9, h: 16 } },
  { value: '16:9', label: '16:9 (Landscape)', dim: { w: 16, h: 9 } },
  { value: '21:9', label: '21:9 (Ultra-wide)', dim: { w: 21, h: 9 } },
]

/**
 * Pick the aspect-ratio dropdown option that best matches the project canvas
 * within ~3 % tolerance. Falls back to `'auto'` ("None / Default") when the
 * canvas's ratio doesn't sit close to any of the canonical buckets — better
 * to leave the prompt unconstrained than to mislabel an unusual canvas.
 */
function pickAspectRatioFromCanvas(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'auto'
  }
  const target = width / height
  let bestValue = 'auto'
  let bestDelta = Infinity
  for (const opt of ASPECT_RATIO_OPTIONS) {
    if (!opt.dim) continue
    const ratio = opt.dim.w / opt.dim.h
    const delta = Math.abs(ratio - target) / target
    if (delta < bestDelta) {
      bestDelta = delta
      bestValue = opt.value
    }
  }
  return bestDelta <= 0.03 ? bestValue : 'auto'
}

function AspectRatioIcon({ dim }: { dim: AspectRatioOption['dim'] }) {
  // Box big enough that 21:9 still shows as a visible bar inside it; padding
  // keeps the stroke from clipping against the SVG edge.
  const BOX_W = 22
  const BOX_H = 14
  const PADDING = 1.5
  const innerW = BOX_W - 2 * PADDING
  const innerH = BOX_H - 2 * PADDING

  let rectW = innerW
  let rectH = innerH
  if (dim) {
    const ratio = dim.w / dim.h
    if (ratio >= innerW / innerH) {
      rectW = innerW
      rectH = innerW / ratio
    } else {
      rectH = innerH
      rectW = innerH * ratio
    }
  }
  return (
    <svg
      width={BOX_W}
      height={BOX_H}
      viewBox={`0 0 ${BOX_W} ${BOX_H}`}
      className="shrink-0 text-muted-foreground"
      aria-hidden
    >
      <rect
        x={(BOX_W - rectW) / 2}
        y={(BOX_H - rectH) / 2}
        width={rectW}
        height={rectH}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        rx={1}
        {...(dim ? {} : { strokeDasharray: '2 2' })}
      />
    </svg>
  )
}

export function AddCoverDialog() {
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
  const [durationSec, setDurationSec] = useState(DEFAULT_COVER_DURATION_SEC)

  const [suggestions, setSuggestions] = useState<readonly CoverTextSuggestion[]>([])
  const [generating, setGenerating] = useState(false)
  const [inserting, setInserting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [aiTitle, setAiTitle] = useState('')
  const [aiTranscript, setAiTranscript] = useState('')
  const [aiAspect, setAiAspect] = useState<string>('auto')
  const [aiCast, setAiCast] = useState<PosterCastValue>('auto')
  const [aiStyle, setAiStyle] = useState<PosterStyleValue>('photoreal')
  const [aiMood, setAiMood] = useState<PosterMoodValue>('auto')
  const [aiQuality, setAiQuality] = useState<PosterQualityValue>('auto')
  const [aiCustomNotes, setAiCustomNotes] = useState('')

  const [aiImageBlob, setAiImageBlob] = useState<Blob | null>(null)
  const [aiImageObjectUrl, setAiImageObjectUrl] = useState<string | null>(null)
  const [aiImageLoading, setAiImageLoading] = useState(false)
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const generateAbortRef = useRef<AbortController | null>(null)
  const aiImageAbortRef = useRef<AbortController | null>(null)
  const aiSummaryAbortRef = useRef<AbortController | null>(null)

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
    setDurationSec(DEFAULT_COVER_DURATION_SEC)
    setSuggestions([])
    setErrorMessage(null)
    setAiTitle('')
    setAiTranscript('')
    setAiAspect('auto')
    setAiCast('auto')
    setAiStyle('photoreal')
    setAiMood('auto')
    setAiQuality('auto')
    setAiCustomNotes('')
    setAiImageBlob(null)
    setAiImageObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setAiImageLoading(false)
    setAiSummaryLoading(false)
    setAiError(null)

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
        setAiAspect(pickAspectRatioFromCanvas(defaults.width, defaults.height))
      } catch {
        // Silent miss — empty fields let the user type their own values.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOpen, compositionId])

  // Abort any pending AI request when the dialog closes.
  useEffect(() => {
    if (isOpen) return
    generateAbortRef.current?.abort()
    generateAbortRef.current = null
    aiImageAbortRef.current?.abort()
    aiImageAbortRef.current = null
    aiSummaryAbortRef.current?.abort()
    aiSummaryAbortRef.current = null
  }, [isOpen])

  // Revoke the last preview URL when the component unmounts.
  useEffect(() => {
    return () => {
      if (aiImageObjectUrl) URL.revokeObjectURL(aiImageObjectUrl)
    }
  }, [aiImageObjectUrl])

  const customConfigured = Boolean(
    visionAnalyzer.baseUrl && visionAnalyzer.apiKey && visionAnalyzer.model,
  )
  const imageGeneratorConfigured = Boolean(
    imageGenerator.baseUrl && imageGenerator.apiKey && imageGenerator.model,
  )

  const aiAvailable = textMode !== 'manual-text' && customConfigured

  const handleGenerate = useCallback(async () => {
    if (!compositionId) return
    if (textMode === 'manual-text') return
    if (!customConfigured) {
      setErrorMessage(
        'Configure base URL, API key, and model in Settings → AI → Custom AI → Vision Analyzer first.',
      )
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
        setErrorMessage(
          'The model did not return any usable suggestions. Try again or edit text manually.',
        )
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setErrorMessage(error instanceof Error ? error.message : 'Failed to generate cover text.')
    } finally {
      if (generateAbortRef.current === controller) generateAbortRef.current = null
      setGenerating(false)
    }
  }, [compositionId, customConfigured, manualPrompt, textMode])

  const handleSuggestionClick = useCallback((suggestion: CoverTextSuggestion) => {
    setPrimary(suggestion.primary)
    setAccent(suggestion.accent ?? '')
    setSecondary(suggestion.secondary ?? '')
  }, [])

  const handleSummariseTranscript = useCallback(async () => {
    if (aiTranscript.trim().length === 0) {
      setAiError('There is no transcript to summarise yet.')
      return
    }
    if (!customConfigured) {
      setAiError('Configure the Vision Analyzer in Settings → AI → Custom AI before summarising.')
      return
    }
    setAiSummaryLoading(true)
    setAiError(null)
    const controller = new AbortController()
    aiSummaryAbortRef.current = controller
    try {
      const summary = await summariseCoverTranscript({
        transcript: aiTranscript,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setAiTranscript(summary)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setAiError(error instanceof Error ? error.message : 'Failed to summarise transcript.')
    } finally {
      if (aiSummaryAbortRef.current === controller) aiSummaryAbortRef.current = null
      setAiSummaryLoading(false)
    }
  }, [aiTranscript, customConfigured])

  const handleGenerateAiImage = useCallback(async () => {
    if (!composition) return
    if (!imageGeneratorConfigured) {
      setAiError(
        'Configure the Image Generator in Settings → AI → Custom AI before generating an image.',
      )
      return
    }
    let prompt: string
    try {
      // 'auto' / "None (Default)" → empty aspect line in the prompt; the
      // image API call still receives the canvas dimensions so the rendered
      // output keeps the project's aspect either way.
      const aspectForPrompt = aiAspect === 'auto' ? '' : aiAspect
      prompt = buildCoverImagePromptFromForm({
        title: aiTitle,
        transcript: aiTranscript,
        aspectLabel: aspectForPrompt,
        cast: aiCast,
        style: aiStyle,
        mood: aiMood,
        customNotes: aiCustomNotes,
      })
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'Cannot build poster prompt.')
      return
    }
    setAiImageLoading(true)
    setAiError(null)
    const controller = new AbortController()
    aiImageAbortRef.current = controller
    try {
      const apiQuality = resolvePosterQualityApiValue(aiQuality)
      const result = await generateCoverImage({
        prompt,
        width: composition.width,
        height: composition.height,
        ...(apiQuality ? { quality: apiQuality } : {}),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setAiImageBlob(result.blob)
      setAiImageObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(result.blob)
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setAiError(error instanceof Error ? error.message : 'Failed to generate image.')
    } finally {
      if (aiImageAbortRef.current === controller) aiImageAbortRef.current = null
      setAiImageLoading(false)
    }
  }, [
    aiAspect,
    aiCast,
    aiCustomNotes,
    aiMood,
    aiQuality,
    aiStyle,
    aiTitle,
    aiTranscript,
    composition,
    imageGeneratorConfigured,
  ])

  const canInsert = useMemo(() => {
    if (!composition) return false
    if (inserting) return false
    if (durationSec < COVER_DURATION_MIN || durationSec > COVER_DURATION_MAX) return false
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
        message: `Cover added (${result.coverDurationFrames} frames)`,
      })
      close()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to insert cover.')
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
          <DialogTitle>Add Cover</DialogTitle>
          <DialogDescription>
            Insert a Vlog-style intro card at the start of this compound clip. Pick a frame, write
            (or generate) the title, and choose the duration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Cover image
            </Label>
            <Tabs
              value={frameSource}
              onValueChange={(value) => setFrameSource(value as FrameSource)}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="frame">Find frame</TabsTrigger>
                <TabsTrigger value="ai">Generate with AI</TabsTrigger>
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
                      Text
                    </Label>
                    <Tabs
                      value={textMode}
                      onValueChange={(value) => setTextMode(value as TextMode)}
                    >
                      <TabsList className="grid w-full grid-cols-3">
                        <TabsTrigger value="transcript">From transcript</TabsTrigger>
                        <TabsTrigger value="manual-prompt">Manual prompt</TabsTrigger>
                        <TabsTrigger value="manual-text">Type myself</TabsTrigger>
                      </TabsList>
                      <TabsContent value="transcript" className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          AI reads the transcript of every video/audio clip inside the compound clip
                          and proposes 3 hook variations.
                        </p>
                      </TabsContent>
                      <TabsContent value="manual-prompt" className="space-y-2">
                        <Textarea
                          value={manualPrompt}
                          onChange={(event) => setManualPrompt(event.target.value)}
                          placeholder='e.g. "video wedding Sari & Andi" or "podcast tentang produktivitas"'
                          rows={2}
                          spellCheck={false}
                          className="resize-none text-sm"
                        />
                      </TabsContent>
                      <TabsContent value="manual-text" className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          AI is off — type the title directly into the fields below.
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
                          {generating ? 'Generating…' : 'Generate'}
                        </Button>
                        {!customConfigured ? (
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            Configure Custom AI in Settings to enable AI text.
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
                        <Label className="text-xs">Primary</Label>
                        <Input
                          value={primary}
                          onChange={(event) => setPrimary(event.target.value)}
                          placeholder="TEKNIK"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Accent</Label>
                        <Input
                          value={accent}
                          onChange={(event) => setAccent(event.target.value)}
                          placeholder="JAGO NGOMONG"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Secondary</Label>
                        <Input
                          value={secondary}
                          onChange={(event) => setSecondary(event.target.value)}
                          placeholder="YANG MENGUBAH HIDUP"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>
              <TabsContent
                value="ai"
                className="mt-2 h-[calc(70vh-220px)] min-h-[260px] space-y-3 overflow-y-auto"
              >
                {imageGeneratorConfigured ? (
                  <p className="text-xs text-muted-foreground">
                    Using model{' '}
                    <span className="font-medium text-foreground">{imageGenerator.model}</span> via{' '}
                    {imageGenerator.baseUrl}.
                  </p>
                ) : (
                  <p
                    role="alert"
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
                  >
                    Configure base URL, API key, and model in Settings → AI → Custom AI → Image
                    Generator before generating.
                  </p>
                )}

                <div className="space-y-1.5">
                  <Label className="text-xs">Title</Label>
                  <Input
                    value={aiTitle}
                    onChange={(event) => setAiTitle(event.target.value)}
                    placeholder="Compound clip title — used as the poster headline."
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">Transcript</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
                      onClick={() => void handleSummariseTranscript()}
                      disabled={
                        aiSummaryLoading ||
                        aiImageLoading ||
                        inserting ||
                        !customConfigured ||
                        aiTranscript.trim().length === 0
                      }
                    >
                      {aiSummaryLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      {aiSummaryLoading ? 'Summarising…' : 'Generate summary'}
                    </Button>
                  </div>
                  <Textarea
                    value={aiTranscript}
                    onChange={(event) => setAiTranscript(event.target.value)}
                    placeholder="Concatenated transcript for this compound. Click Generate summary to compress it while preserving the story arc."
                    rows={6}
                    spellCheck={false}
                    className="resize-y text-sm"
                  />
                  {!customConfigured ? (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                      Configure Vision Analyzer in Settings to enable summarisation.
                    </p>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Aspect ratio</Label>
                    <Select value={aiAspect} onValueChange={(value) => setAiAspect(value)}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ASPECT_RATIO_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value} className="text-sm">
                            <div className="flex items-center gap-2">
                              <AspectRatioIcon dim={opt.dim} />
                              <span>{opt.label}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Target country / cast</Label>
                    <Select
                      value={aiCast}
                      onValueChange={(value) => setAiCast(value as PosterCastValue)}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {POSTER_CAST_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value} className="text-sm">
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Visual style</Label>
                    <Select
                      value={aiStyle}
                      onValueChange={(value) => setAiStyle(value as PosterStyleValue)}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {POSTER_STYLE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value} className="text-sm">
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Mood / genre</Label>
                    <Select
                      value={aiMood}
                      onValueChange={(value) => setAiMood(value as PosterMoodValue)}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {POSTER_MOOD_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value} className="text-sm">
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Image quality</Label>
                  <Select
                    value={aiQuality}
                    onValueChange={(value) => setAiQuality(value as PosterQualityValue)}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {POSTER_QUALITY_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className="text-sm">
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Honoured by OpenAI <code className="text-foreground">gpt-image-1</code> (more
                    cost / time at higher tiers). Other providers (Gemini "nano-banana", Grok)
                    silently ignore this field.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Custom notes (optional)</Label>
                  <Textarea
                    value={aiCustomNotes}
                    onChange={(event) => setAiCustomNotes(event.target.value)}
                    placeholder="Any extra art-direction notes — e.g. 'set in 1990s Jakarta', 'rain-soaked alley'."
                    rows={2}
                    spellCheck={false}
                    className="resize-y text-sm"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => void handleGenerateAiImage()}
                    disabled={
                      !imageGeneratorConfigured ||
                      aiImageLoading ||
                      aiSummaryLoading ||
                      inserting ||
                      (aiTitle.trim().length === 0 && aiTranscript.trim().length === 0)
                    }
                    size="sm"
                  >
                    {aiImageLoading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {aiImageLoading
                      ? 'Generating…'
                      : aiImageBlob
                        ? 'Regenerate image'
                        : 'Generate image'}
                  </Button>
                  {!imageGeneratorConfigured ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Configure Image Generator in Settings to generate images.
                    </p>
                  ) : null}
                </div>

                {aiError ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    {aiError}
                  </p>
                ) : null}
                {aiImageObjectUrl ? (
                  <ImageLightbox
                    src={aiImageObjectUrl}
                    alt="Generated poster preview"
                    downloadFilename={`cover-ai-${compositionId.slice(0, 8)}.png`}
                  >
                    <button
                      type="button"
                      className="flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md border border-border bg-secondary/40"
                      aria-label="Open generated poster preview"
                    >
                      <img
                        src={aiImageObjectUrl}
                        alt="Generated poster preview"
                        className="block h-[400px] w-auto"
                        style={{ aspectRatio: `${composition.width} / ${composition.height}` }}
                      />
                    </button>
                  </ImageLightbox>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Cover renders at {composition.width}×{composition.height}. Tweak the form above
                    and click Generate image.
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Duration
              </Label>
              <span className="text-xs text-muted-foreground">{durationSec.toFixed(1)} s</span>
            </div>
            <Slider
              min={COVER_DURATION_MIN}
              max={COVER_DURATION_MAX}
              step={0.1}
              value={[durationSec]}
              onValueChange={(values) => {
                const next = values[0]
                if (typeof next === 'number') {
                  setDurationSec(Math.round(next * 10) / 10)
                }
              }}
              aria-label="Cover duration"
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
            Cancel
          </Button>
          <Button onClick={() => void handleInsert()} disabled={!canInsert}>
            {inserting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {inserting ? 'Inserting…' : 'Insert Cover'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
