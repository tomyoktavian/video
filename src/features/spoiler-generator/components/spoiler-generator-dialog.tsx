import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Sparkles, Square } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSpoilerGeneratorDialogStore } from '@/app/state/spoiler-generator-dialog'

import {
  isCaptionMakerConfigured,
  isTextToSpeechConfigured,
  isVisionAnalyzerConfigured,
  useCustomAiStore,
  useSettingsStore,
  type SubtitleGranularity,
} from '../deps/settings'
import { useMediaLibraryStore } from '../deps/media-library'
import { runSpoilerPipeline } from '../spoiler-orchestrator'
import type { SpoilerProgress, SpoilerStage } from '../types'
import { SpoilerProgressStepper } from './spoiler-progress-stepper'

const TARGET_DURATION_OPTIONS: ComboboxOption[] = [
  { value: '300', label: '5 minutes (fast)' },
  { value: '600', label: '10 minutes' },
  { value: '900', label: '15 minutes (recommended)' },
  { value: '1200', label: '20 minutes' },
]

const NARRATION_LANGUAGE_OPTIONS: ComboboxOption[] = [
  { value: 'id', label: 'Indonesian (default)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese (Mandarin)' },
]

const CLIP_DURATION_BOUNDS = { min: 5, max: 90 }
const TTS_SPEED_BOUNDS = { min: 0.5, max: 2.0 }

const GRANULARITY_OPTIONS: ComboboxOption[] = [
  { value: 'word', label: 'Word (karaoke)' },
  { value: 'phrase', label: 'Phrase (TikTok / CapCut)' },
  { value: 'sentence', label: 'Sentence' },
]

export function SpoilerGeneratorDialog() {
  const isOpen = useSpoilerGeneratorDialogStore((s) => s.isOpen)
  const mediaId = useSpoilerGeneratorDialogStore((s) => s.mediaId)
  const close = useSpoilerGeneratorDialogStore((s) => s.close)

  const captionMaker = useCustomAiStore((s) => s.captionMaker)
  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const textToSpeech = useCustomAiStore((s) => s.textToSpeech)
  const defaultGranularity = useSettingsStore((s) => s.defaultSubtitleGranularity)
  const mediaById = useMediaLibraryStore((s) => s.mediaById)
  const transcriptStatus = useMediaLibraryStore((s) => s.transcriptStatus)

  const [step, setStep] = useState<'settings' | 'progress'>('settings')
  const [targetDurationSec, setTargetDurationSec] = useState<number>(1200)
  const [narrationLanguage, setNarrationLanguage] = useState<string>('id')
  const [clipDurationSec, setClipDurationSec] = useState<number>(30)
  const [generateCover, setGenerateCover] = useState(false)
  const [addSubtitles, setAddSubtitles] = useState(false)
  const [includeOriginalAudio, setIncludeOriginalAudio] = useState(true)
  const [subtitleGranularity, setSubtitleGranularity] =
    useState<SubtitleGranularity>(defaultGranularity)
  const [ttsSpeed, setTtsSpeed] = useState<number>(1)
  const [voicePreset, setVoicePreset] = useState<string>('')

  const [progress, setProgress] = useState<SpoilerProgress | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setStep('settings')
    setProgress(null)
    setErrorMessage(null)
    setIsRunning(false)
    setVoicePreset(textToSpeech.voice || '')
    setSubtitleGranularity(defaultGranularity)
    setTtsSpeed(1)
    setIncludeOriginalAudio(true)
  }, [isOpen, textToSpeech.voice, defaultGranularity])

  const media = mediaId ? mediaById[mediaId] : null
  const transcriptReady = mediaId ? transcriptStatus.get(mediaId) === 'ready' : false

  const captionConfigured = isCaptionMakerConfigured(captionMaker)
  const visionConfigured = isVisionAnalyzerConfigured(visionAnalyzer)
  const ttsConfigured = isTextToSpeechConfigured(textToSpeech)

  const voiceOptions: ComboboxOption[] = textToSpeech.cachedVoices.map((entry) => ({
    value: entry.id,
    label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
  }))

  const canRun =
    !!media &&
    captionConfigured &&
    visionConfigured &&
    ttsConfigured &&
    transcriptReady &&
    !isRunning

  const handleStart = useCallback(async () => {
    if (!media || !mediaId) return
    const controller = new AbortController()
    abortRef.current = controller
    setStep('progress')
    setProgress({ stage: 'idle', message: 'Starting...' })
    setErrorMessage(null)
    setIsRunning(true)
    try {
      await runSpoilerPipeline(
        {
          mediaId,
          targetDurationSec,
          narrationLanguage,
          clipDurationSec,
          generateCover,
          addSubtitles,
          includeOriginalAudio,
          subtitleGranularity,
          voiceSpeed: ttsSpeed,
          ...(voicePreset ? { voicePreset } : {}),
        },
        {
          onProgress: (p) => setProgress(p),
          signal: controller.signal,
        },
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setProgress({ stage: 'idle', message: 'Cancelled.' })
      } else {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }, [
    media,
    mediaId,
    targetDurationSec,
    narrationLanguage,
    clipDurationSec,
    generateCover,
    addSubtitles,
    includeOriginalAudio,
    subtitleGranularity,
    ttsSpeed,
    voicePreset,
  ])

  const handleCancelRun = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleClose = useCallback(() => {
    if (isRunning) return
    close()
  }, [close, isRunning])

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (next) return
        // Block all close attempts (programmatic close, parent re-render) while
        // the pipeline is running — user must hit Cancel first to abort.
        if (isRunning) return
        handleClose()
      }}
    >
      <AlertDialogContent
        className="max-w-md"
        onEscapeKeyDown={(event) => {
          if (isRunning) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Auto Spoiler Generator
          </AlertDialogTitle>
          <AlertDialogDescription>
            AI writes the script, picks clips, generates narration, and wraps everything into a
            single compound clip ready to export.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step === 'settings' && (
          <div className="space-y-3">
            {!media && (
              <Alert variant="error">
                Media file not found in the library. Close this dialog and pick a valid media.
              </Alert>
            )}

            {media && !captionConfigured && (
              <Alert variant="error">
                Caption Maker (for film transcription) is not configured. Open{' '}
                <strong>Settings → AI → Custom AI → Caption Maker</strong>.
              </Alert>
            )}

            {media && !visionConfigured && (
              <Alert variant="error">
                Vision Analyzer (for the Script Writer) is not configured. Open{' '}
                <strong>Settings → AI → Custom AI → Vision Analyzer</strong>.
              </Alert>
            )}

            {media && !ttsConfigured && (
              <Alert variant="error">
                Text to Speech (for narration) is not configured. Open{' '}
                <strong>Settings → AI → Custom AI → Text to Speech</strong>.
              </Alert>
            )}

            {media && !transcriptReady && (
              <Alert variant="warning">
                Film transcript not ready yet. Right-click the media → "Transcribe" first.
              </Alert>
            )}

            <div className="space-y-1.5">
              <Label className="text-sm">Spoiler Duration</Label>
              <Combobox
                value={String(targetDurationSec)}
                options={TARGET_DURATION_OPTIONS}
                onValueChange={(value) => setTargetDurationSec(Number(value))}
                placeholder="Select duration"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Narration Language</Label>
              <Combobox
                value={narrationLanguage}
                options={NARRATION_LANGUAGE_OPTIONS}
                onValueChange={setNarrationLanguage}
                placeholder="Select language"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Average clip duration per segment (seconds)</Label>
              <Input
                type="number"
                min={CLIP_DURATION_BOUNDS.min}
                max={CLIP_DURATION_BOUNDS.max}
                value={clipDurationSec}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next)) {
                    setClipDurationSec(
                      Math.min(CLIP_DURATION_BOUNDS.max, Math.max(CLIP_DURATION_BOUNDS.min, next)),
                    )
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Clips taken from the film are auto-adjusted to match the narration duration.
              </p>
            </div>

            {voiceOptions.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-sm">Narration Voice</Label>
                <Combobox
                  value={voicePreset}
                  options={voiceOptions}
                  onValueChange={setVoicePreset}
                  placeholder="Use the default voice from Settings"
                  searchPlaceholder="Search voices..."
                  emptyMessage="No voices yet — load them in Settings."
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-sm">Narration Speed</Label>
              <Input
                type="number"
                min={TTS_SPEED_BOUNDS.min}
                max={TTS_SPEED_BOUNDS.max}
                step={0.1}
                value={ttsSpeed}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (Number.isFinite(next)) {
                    setTtsSpeed(
                      Math.min(TTS_SPEED_BOUNDS.max, Math.max(TTS_SPEED_BOUNDS.min, next)),
                    )
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                1.0 = normal. Higher = faster. Provider-dependent.
              </p>
            </div>

            <div className="rounded-md border px-3 py-2.5 space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Include in spoiler
              </p>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-add-subtitles" className="text-sm">
                    Subtitles
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Built from the narration text + per-word timing.
                  </p>
                </div>
                <Switch
                  id="spoiler-add-subtitles"
                  checked={addSubtitles}
                  onCheckedChange={setAddSubtitles}
                />
              </div>

              {addSubtitles && (
                <div className="space-y-1.5 pl-1 border-l-2 border-muted">
                  <Label className="text-xs text-muted-foreground">Subtitle granularity</Label>
                  <Combobox
                    value={subtitleGranularity}
                    options={GRANULARITY_OPTIONS}
                    onValueChange={(value) => setSubtitleGranularity(value as SubtitleGranularity)}
                    placeholder="Select granularity"
                  />
                </div>
              )}

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-generate-cover" className="text-sm">
                    Cover
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Title + thumbnail at the start of the compound.
                  </p>
                </div>
                <Switch
                  id="spoiler-generate-cover"
                  checked={generateCover}
                  onCheckedChange={setGenerateCover}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-include-original-audio" className="text-sm">
                    Original audio
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Source film audio ducked under narration. Off = narration only.
                  </p>
                </div>
                <Switch
                  id="spoiler-include-original-audio"
                  checked={includeOriginalAudio}
                  onCheckedChange={setIncludeOriginalAudio}
                />
              </div>
            </div>
          </div>
        )}

        {step === 'progress' && (
          <div className="space-y-3">
            {progress && (
              <div className="space-y-3">
                <p className="text-sm">{progress.message}</p>
                <SpoilerProgressStepper
                  currentStage={progress.stage as SpoilerStage}
                  showSubtitles={addSubtitles}
                  showCover={generateCover}
                />
                {progress.segmentTotal !== undefined &&
                  progress.segmentIndex !== undefined &&
                  progress.segmentTotal > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Segment {progress.segmentIndex} / {progress.segmentTotal}
                    </p>
                  )}
              </div>
            )}
            {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
            {progress?.stage === 'done' && !errorMessage && (
              <Alert variant="success">
                Spoiler is ready. Open the compound clip in the timeline to preview, or export to
                MP4.
              </Alert>
            )}
          </div>
        )}

        <AlertDialogFooter>
          {step === 'settings' && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleStart} disabled={!canRun}>
                <Sparkles className="mr-1.5 h-4 w-4" />
                Generate Spoiler
              </Button>
            </>
          )}
          {step === 'progress' && (
            <>
              {isRunning && (
                <Button variant="ghost" onClick={handleCancelRun}>
                  <Square className="mr-1.5 h-4 w-4" />
                  Cancel
                </Button>
              )}
              {!isRunning && (
                <>
                  <Button variant="ghost" onClick={() => setStep('settings')}>
                    Back
                  </Button>
                  <Button onClick={handleClose}>Close</Button>
                </>
              )}
              {isRunning && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface AlertProps {
  variant: 'error' | 'warning' | 'success'
  children: React.ReactNode
}

function Alert(props: AlertProps) {
  const styles =
    props.variant === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : props.variant === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${styles}`} role="alert">
      {props.children}
    </div>
  )
}
