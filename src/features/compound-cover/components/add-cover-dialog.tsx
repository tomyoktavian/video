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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAddCoverDialogStore } from '@/app/state/add-cover-dialog'

import { useCustomAiStore } from '../deps/settings'
import { useCompositionsStore, useMediaLibraryStore } from '../deps/timeline'
import { generateCoverText } from '../cover-service'
import { persistCoverFrame, renderCoverFrame } from '../frame-extraction'
import { insertCover } from '../insert-cover-action'
import type { CoverTextSuggestion } from '../types'

import { FramePicker } from './frame-picker'

const DEFAULT_COVER_DURATION_SEC = 3
const COVER_DURATION_MIN = 1
const COVER_DURATION_MAX = 10

type TextMode = 'transcript' | 'manual-prompt' | 'manual-text'

export function AddCoverDialog() {
  const isOpen = useAddCoverDialogStore((s) => s.isOpen)
  const compositionId = useAddCoverDialogStore((s) => s.compositionId)
  const close = useAddCoverDialogStore((s) => s.close)

  const composition = useCompositionsStore((s) =>
    compositionId ? s.compositionById[compositionId] : undefined,
  )
  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const showNotification = useMediaLibraryStore((s) => s.showNotification)

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

  const generateAbortRef = useRef<AbortController | null>(null)

  // Reset dialog state every time it (re)opens.
  useEffect(() => {
    if (!isOpen) return
    setSelectedFrame(0)
    setTextMode('transcript')
    setManualPrompt('')
    setPrimary('')
    setAccent('')
    setSecondary('')
    setDurationSec(DEFAULT_COVER_DURATION_SEC)
    setSuggestions([])
    setErrorMessage(null)
  }, [isOpen, compositionId])

  // Abort any pending AI request when the dialog closes.
  useEffect(() => {
    if (isOpen) return
    generateAbortRef.current?.abort()
    generateAbortRef.current = null
  }, [isOpen])

  const customConfigured = Boolean(
    visionAnalyzer.baseUrl && visionAnalyzer.apiKey && visionAnalyzer.model,
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

  const canInsert = useMemo(() => {
    if (!composition) return false
    if (inserting) return false
    if (primary.trim().length === 0) return false
    if (durationSec < COVER_DURATION_MIN || durationSec > COVER_DURATION_MAX) return false
    return true
  }, [composition, inserting, primary, durationSec])

  const handleInsert = useCallback(async () => {
    if (!compositionId || !composition) return
    setInserting(true)
    setErrorMessage(null)
    try {
      const blob = await renderCoverFrame(compositionId, selectedFrame, {
        width: composition.width,
        height: composition.height,
        quality: 0.92,
      })
      const persisted = await persistCoverFrame(
        compositionId,
        blob,
        composition.width,
        composition.height,
      )
      const frameSrc = persisted.opfsPath
        ? `opfs://${persisted.opfsPath}`
        : URL.createObjectURL(blob)

      const result = insertCover({
        compositionId,
        durationSec,
        frameMediaId: persisted.id,
        frameSrc,
        frameWidth: composition.width,
        frameHeight: composition.height,
        primary,
        accent,
        secondary,
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
    close,
    composition,
    compositionId,
    durationSec,
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
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Frame</Label>
            <FramePicker
              compositionId={compositionId}
              selectedFrame={selectedFrame}
              onChange={setSelectedFrame}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Text</Label>
            <Tabs value={textMode} onValueChange={(value) => setTextMode(value as TextMode)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="transcript">From transcript</TabsTrigger>
                <TabsTrigger value="manual-prompt">Manual prompt</TabsTrigger>
                <TabsTrigger value="manual-text">Type myself</TabsTrigger>
              </TabsList>
              <TabsContent value="transcript" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  AI reads the transcript of every video/audio clip inside the compound clip and
                  proposes 3 hook variations.
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
