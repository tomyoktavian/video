import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Loader2, Sparkles, Square } from 'lucide-react'

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
import { Textarea } from '@/components/ui/textarea'
import { useSpoilerGeneratorDialogStore } from '@/app/state/spoiler-generator-dialog'

import {
  AiImagePanel,
  type AiImageGeneratedPayload,
  persistCoverFrame,
} from '../deps/compound-cover'
import {
  isCaptionMakerConfigured,
  isImageGeneratorConfigured,
  isTextToSpeechConfigured,
  isVisionAnalyzerConfigured,
  useCustomAiStore,
  useSettingsStore,
} from '../deps/settings'
import {
  clampWordsPerCaption,
  MAX_WORDS_PER_CAPTION,
  useMediaLibraryStore,
} from '../deps/media-library'
import { useProjectStore } from '../deps/project'
import { getTranscript } from '../deps/transcription'
import { substituteTemplate } from '../episode-narration-generator'
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
const TTS_SPEED_BOUNDS = { min: 0.5, max: 4.0 }
const BOUNDARY_NARRATION_SPEED_BOUNDS = { min: 0.5, max: 4.0 }
const COVER_DURATION_BOUNDS = { min: 0.5, max: 5 }
const EPISODE_MIN_DURATION_BOUNDS = { min: 60, max: 119 }
const EPISODE_MAX_DURATION_BOUNDS = { min: 61, max: 120 }
const DEFAULT_EPISODE_OPENING = 'Selamat datang di episode {n}'
const DEFAULT_EPISODE_CLOSING = 'Lanjutkan nonton di episode {next}'
const DEFAULT_COVER_DURATION_SEC = 4
const DEFAULT_BOUNDARY_NARRATION_SPEED = 1

type DialogStep = 'settings' | 'ai-cover' | 'confirm' | 'progress'

interface PersistedCover {
  mediaId: string
  src: string
  width: number
  height: number
}

export function SpoilerGeneratorDialog() {
  const isOpen = useSpoilerGeneratorDialogStore((s) => s.isOpen)
  const mediaId = useSpoilerGeneratorDialogStore((s) => s.mediaId)
  const close = useSpoilerGeneratorDialogStore((s) => s.close)

  const captionMaker = useCustomAiStore((s) => s.captionMaker)
  const visionAnalyzer = useCustomAiStore((s) => s.visionAnalyzer)
  const textToSpeech = useCustomAiStore((s) => s.textToSpeech)
  const imageGenerator = useCustomAiStore((s) => s.imageGenerator)
  const mediaById = useMediaLibraryStore((s) => s.mediaById)
  const transcriptStatus = useMediaLibraryStore((s) => s.transcriptStatus)
  const defaultWordsPerCaption = useSettingsStore((s) => s.defaultWordsPerCaption)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const currentProject = useProjectStore((s) => s.currentProject)

  const canvasWidth = currentProject?.metadata?.width ?? 1920
  const canvasHeight = currentProject?.metadata?.height ?? 1080

  const [step, setStep] = useState<DialogStep>('settings')
  const [targetDurationSec, setTargetDurationSec] = useState<number>(1200)
  const [narrationLanguage, setNarrationLanguage] = useState<string>('id')
  const [clipDurationSec, setClipDurationSec] = useState<number>(30)
  const [addSubtitles, setAddSubtitles] = useState(false)
  const [ttsSpeed, setTtsSpeed] = useState<number>(1)
  const [voicePreset, setVoicePreset] = useState<string>('')
  const [wordsPerCaption, setWordsPerCaption] = useState<number>(defaultWordsPerCaption)
  const [episodeMode, setEpisodeMode] = useState(false)
  const [episodeMinDurationSec, setEpisodeMinDurationSec] = useState<number>(60)
  const [episodeMaxDurationSec, setEpisodeMaxDurationSec] = useState<number>(120)
  const [episodeOpeningTemplate, setEpisodeOpeningTemplate] =
    useState<string>(DEFAULT_EPISODE_OPENING)
  const [episodeClosingTemplate, setEpisodeClosingTemplate] =
    useState<string>(DEFAULT_EPISODE_CLOSING)
  const [episodeCount, setEpisodeCount] = useState<number>(0)
  const episodeCountUserEditedRef = useRef(false)

  const [generateCoverWithAi, setGenerateCoverWithAi] = useState(false)
  const [coverDurationSec, setCoverDurationSec] = useState<number>(DEFAULT_COVER_DURATION_SEC)
  const [boundaryNarrationSpeed, setBoundaryNarrationSpeed] = useState<number>(
    DEFAULT_BOUNDARY_NARRATION_SPEED,
  )
  // Title + transcript stay in parent state because the prefill effect
  // populates them async from the source media's existing transcript. Other
  // taste fields (cast/style/mood/quality/customNotes) are owned by the
  // panel via `initialValues`.
  const [aiTitle, setAiTitle] = useState('')
  const [aiTranscript, setAiTranscript] = useState('')
  const [aiPrefillLoading, setAiPrefillLoading] = useState(false)
  const [aiTranscriptLoaded, setAiTranscriptLoaded] = useState(false)
  const [persistError, setPersistError] = useState<string | null>(null)
  const [persistedCover, setPersistedCover] = useState<PersistedCover | null>(null)
  /** Bumped when re-entering the ai-cover step to remount the panel. */
  const [aiPanelKey, setAiPanelKey] = useState(0)
  const aiPrefilledForMediaIdRef = useRef<string | null>(null)

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
    setTtsSpeed(1)
    setWordsPerCaption(defaultWordsPerCaption)
    setEpisodeMode(false)
    setEpisodeMinDurationSec(60)
    setEpisodeMaxDurationSec(120)
    setEpisodeOpeningTemplate(DEFAULT_EPISODE_OPENING)
    setEpisodeClosingTemplate(DEFAULT_EPISODE_CLOSING)
    setEpisodeCount(0)
    episodeCountUserEditedRef.current = false

    setGenerateCoverWithAi(false)
    setCoverDurationSec(DEFAULT_COVER_DURATION_SEC)
    setBoundaryNarrationSpeed(DEFAULT_BOUNDARY_NARRATION_SPEED)
    setPersistedCover(null)
    setPersistError(null)
    setAiTitle('')
    setAiTranscript('')
    setAiTranscriptLoaded(false)
    setAiPrefillLoading(false)
    setAiPanelKey((k) => k + 1)
    aiPrefilledForMediaIdRef.current = null
  }, [isOpen, textToSpeech.voice, defaultWordsPerCaption])

  const media = mediaId ? mediaById[mediaId] : null
  const transcriptReady = mediaId ? transcriptStatus.get(mediaId) === 'ready' : false

  // Pre-fill AI title and transcript from the source media's existing
  // workspace transcript when entering the AI cover step. The Spoiler
  // Generator already gates on `transcriptReady`, so the file should exist;
  // we still tolerate read failures (the user can edit the fields manually).
  useEffect(() => {
    if (step !== 'ai-cover') return
    if (!mediaId || !media) return
    if (aiPrefilledForMediaIdRef.current === mediaId) return
    aiPrefilledForMediaIdRef.current = mediaId

    const fileName = media.fileName ?? ''
    const cleanedFileName = fileName
      .replace(/\.[^./\\]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim()
    if (cleanedFileName.length > 0) setAiTitle(cleanedFileName)

    setAiPrefillLoading(true)
    let cancelled = false
    void (async () => {
      try {
        const transcript = await getTranscript(mediaId)
        if (cancelled) return
        const text = transcript?.text?.trim() ?? ''
        if (text.length > 0) {
          setAiTranscript(text)
          setAiTranscriptLoaded(true)
        } else {
          setAiTranscriptLoaded(false)
        }
      } catch {
        if (cancelled) return
        setAiTranscriptLoaded(false)
      } finally {
        if (!cancelled) setAiPrefillLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [step, mediaId, media])

  const captionConfigured = isCaptionMakerConfigured(captionMaker)
  const visionConfigured = isVisionAnalyzerConfigured(visionAnalyzer)
  const ttsConfigured = isTextToSpeechConfigured(textToSpeech)
  const imageGeneratorConfigured = isImageGeneratorConfigured(imageGenerator)

  const voiceOptions: ComboboxOption[] = textToSpeech.cachedVoices.map((entry) => ({
    value: entry.id,
    label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
  }))

  const autoEpisodeCount = Math.max(
    1,
    Math.ceil(targetDurationSec / Math.max(1, episodeMaxDurationSec)),
  )
  const effectiveEpisodeCount =
    episodeCountUserEditedRef.current && episodeCount > 0 ? episodeCount : autoEpisodeCount

  const episodeFormValid =
    !episodeMode ||
    (episodeOpeningTemplate.trim().length > 0 &&
      episodeClosingTemplate.trim().length > 0 &&
      episodeMinDurationSec >= EPISODE_MIN_DURATION_BOUNDS.min &&
      episodeMinDurationSec < episodeMaxDurationSec &&
      episodeMaxDurationSec <= EPISODE_MAX_DURATION_BOUNDS.max &&
      effectiveEpisodeCount >= 1)

  const canRunBase =
    !!media &&
    captionConfigured &&
    visionConfigured &&
    ttsConfigured &&
    transcriptReady &&
    episodeFormValid &&
    !isRunning

  const canRunWithoutAiCover = canRunBase && !generateCoverWithAi
  const canRunWithAiCover = canRunBase && generateCoverWithAi && !!persistedCover

  // Persist the AI image as soon as it arrives so the "Generate Spoiler"
  // button enables right after generation. Uses the source media id as a
  // stable ownership key — no composition exists yet at this stage.
  const handleAiImageGenerated = useCallback(
    async (payload: AiImageGeneratedPayload) => {
      setPersistError(null)
      setPersistedCover(null)
      try {
        const persisted = await persistCoverFrame(
          mediaId ?? 'spoiler-cover',
          payload.blob,
          canvasWidth,
          canvasHeight,
          { source: 'ai' },
        )
        const src = persisted.opfsPath ? `opfs://${persisted.opfsPath}` : ''
        setPersistedCover({
          mediaId: persisted.id,
          src,
          width: canvasWidth,
          height: canvasHeight,
        })
      } catch (error) {
        setPersistError(error instanceof Error ? error.message : 'Failed to save AI cover.')
      }
    },
    [canvasHeight, canvasWidth, mediaId],
  )

  const startPipeline = useCallback(
    async (preGeneratedCover: PersistedCover | null) => {
      if (!media || !mediaId) return
      const normalizedWordsPerCaption = clampWordsPerCaption(wordsPerCaption)
      if (addSubtitles) {
        setSetting('defaultWordsPerCaption', normalizedWordsPerCaption)
      }
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
            generateCover: !!preGeneratedCover,
            addSubtitles,
            includeOriginalAudio: true,
            voiceSpeed: ttsSpeed,
            ...(voicePreset ? { voicePreset } : {}),
            ...(addSubtitles ? { wordsPerCaption: normalizedWordsPerCaption } : {}),
            ...(episodeMode
              ? {
                  episodeMode: true,
                  episodeMinDurationSec,
                  episodeMaxDurationSec,
                  episodeOpeningTemplate: episodeOpeningTemplate.trim(),
                  episodeClosingTemplate: episodeClosingTemplate.trim(),
                  episodeCount: effectiveEpisodeCount,
                  boundaryNarrationSpeed,
                }
              : {}),
            ...(preGeneratedCover ? { preGeneratedCover, coverDurationSec } : {}),
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
    },
    [
      addSubtitles,
      boundaryNarrationSpeed,
      clipDurationSec,
      coverDurationSec,
      effectiveEpisodeCount,
      episodeClosingTemplate,
      episodeMaxDurationSec,
      episodeMinDurationSec,
      episodeMode,
      episodeOpeningTemplate,
      media,
      mediaId,
      narrationLanguage,
      setSetting,
      targetDurationSec,
      ttsSpeed,
      voicePreset,
      wordsPerCaption,
    ],
  )

  // Step routing (in order):
  //   settings → [ai-cover (when AI cover ON)] → confirm → progress
  const handlePrimary = useCallback(async () => {
    if (step === 'settings') {
      if (generateCoverWithAi) {
        setStep('ai-cover')
      } else {
        setStep('confirm')
      }
      return
    }
    if (step === 'ai-cover') {
      if (!persistedCover) return
      setStep('confirm')
      return
    }
    if (step === 'confirm') {
      await startPipeline(generateCoverWithAi ? persistedCover : null)
      return
    }
  }, [generateCoverWithAi, persistedCover, startPipeline, step])

  const handleConfirmBack = useCallback(() => {
    setStep(generateCoverWithAi ? 'ai-cover' : 'settings')
  }, [generateCoverWithAi])

  const handleCancelRun = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleClose = useCallback(() => {
    if (isRunning) return
    close()
  }, [close, isRunning])

  const handleEpisodeCountChange = useCallback((value: number) => {
    if (!Number.isFinite(value)) return
    episodeCountUserEditedRef.current = true
    setEpisodeCount(Math.max(1, Math.floor(value)))
  }, [])

  const primaryButtonLabel = useMemo(() => {
    if (step === 'settings') return generateCoverWithAi ? 'Next: Cover Settings' : 'Next: Review'
    if (step === 'ai-cover') return 'Next: Review'
    if (step === 'confirm') return 'Confirm & Generate'
    return 'Generate Spoiler'
  }, [generateCoverWithAi, step])

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (next) return
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
          <div className="-mr-2 max-h-[calc(85vh-180px)] space-y-3 overflow-y-auto pr-2">
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
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-episode-mode" className="text-sm">
                    Episode mode
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Split into multiple compound clips with TTS opening/closing per episode. A full
                    spoiler compound is also produced.
                  </p>
                </div>
                <Switch
                  id="spoiler-episode-mode"
                  checked={episodeMode}
                  onCheckedChange={setEpisodeMode}
                />
              </div>

              {episodeMode && (
                <div className="space-y-2.5 pl-1">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label
                        htmlFor="spoiler-episode-min"
                        className="text-xs text-muted-foreground"
                      >
                        Min duration (s)
                      </Label>
                      <Input
                        id="spoiler-episode-min"
                        type="number"
                        min={EPISODE_MIN_DURATION_BOUNDS.min}
                        max={EPISODE_MIN_DURATION_BOUNDS.max}
                        step={1}
                        value={episodeMinDurationSec}
                        disabled={isRunning}
                        onChange={(event) => {
                          const next = Number(event.target.value)
                          if (Number.isFinite(next)) {
                            setEpisodeMinDurationSec(
                              Math.min(
                                EPISODE_MIN_DURATION_BOUNDS.max,
                                Math.max(EPISODE_MIN_DURATION_BOUNDS.min, next),
                              ),
                            )
                          }
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label
                        htmlFor="spoiler-episode-max"
                        className="text-xs text-muted-foreground"
                      >
                        Max duration (s)
                      </Label>
                      <Input
                        id="spoiler-episode-max"
                        type="number"
                        min={EPISODE_MAX_DURATION_BOUNDS.min}
                        max={EPISODE_MAX_DURATION_BOUNDS.max}
                        step={1}
                        value={episodeMaxDurationSec}
                        disabled={isRunning}
                        onChange={(event) => {
                          const next = Number(event.target.value)
                          if (Number.isFinite(next)) {
                            setEpisodeMaxDurationSec(
                              Math.min(
                                EPISODE_MAX_DURATION_BOUNDS.max,
                                Math.max(EPISODE_MAX_DURATION_BOUNDS.min, next),
                              ),
                            )
                          }
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label
                      htmlFor="spoiler-episode-count"
                      className="text-xs text-muted-foreground"
                    >
                      Number of episodes
                    </Label>
                    <Input
                      id="spoiler-episode-count"
                      type="number"
                      min={1}
                      step={1}
                      value={effectiveEpisodeCount}
                      disabled={isRunning}
                      onChange={(event) => handleEpisodeCountChange(Number(event.target.value))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Default {autoEpisodeCount} (spoiler duration ÷ max episode duration). Total
                      runtime ≥ spoiler duration is guaranteed when default is used.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label
                      htmlFor="spoiler-episode-opening"
                      className="text-xs text-muted-foreground"
                    >
                      Opening template (episodes 2..N)
                    </Label>
                    <Textarea
                      id="spoiler-episode-opening"
                      rows={2}
                      value={episodeOpeningTemplate}
                      disabled={isRunning}
                      onChange={(event) => setEpisodeOpeningTemplate(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Use <code>{'{n}'}</code> for current episode and <code>{'{next}'}</code> for
                      next.
                    </p>
                    {episodeOpeningTemplate.trim() && (
                      <p className="text-xs italic text-muted-foreground">
                        Episode 2 opening: “
                        {substituteTemplate(episodeOpeningTemplate, { n: 2, next: 3 })}”
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label
                      htmlFor="spoiler-episode-closing"
                      className="text-xs text-muted-foreground"
                    >
                      Closing template (episodes 1..N-1)
                    </Label>
                    <Textarea
                      id="spoiler-episode-closing"
                      rows={2}
                      value={episodeClosingTemplate}
                      disabled={isRunning}
                      onChange={(event) => setEpisodeClosingTemplate(event.target.value)}
                    />
                    {episodeClosingTemplate.trim() && (
                      <p className="text-xs italic text-muted-foreground">
                        Episode 1 closing: “
                        {substituteTemplate(episodeClosingTemplate, { n: 1, next: 2 })}”
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label
                      htmlFor="spoiler-boundary-speed"
                      className="text-xs text-muted-foreground"
                    >
                      Opening / closing speed (×)
                    </Label>
                    <Input
                      id="spoiler-boundary-speed"
                      type="number"
                      min={BOUNDARY_NARRATION_SPEED_BOUNDS.min}
                      max={BOUNDARY_NARRATION_SPEED_BOUNDS.max}
                      step={0.1}
                      value={boundaryNarrationSpeed}
                      disabled={isRunning}
                      onChange={(event) => {
                        const next = Number(event.target.value)
                        if (Number.isFinite(next)) {
                          setBoundaryNarrationSpeed(
                            Math.min(
                              BOUNDARY_NARRATION_SPEED_BOUNDS.max,
                              Math.max(BOUNDARY_NARRATION_SPEED_BOUNDS.min, next),
                            ),
                          )
                        }
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Client-side playback rate for the opening/closing audio. Use this if the TTS
                      provider returns slow boundary narration. 1 = no change, 2 = twice as fast.
                    </p>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Episode 1 has no opening; the last episode has no closing. The closing window
                    keeps a B-roll continuation video playing under the CTA text.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-md border px-3 py-2.5 space-y-2.5">
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
                <div className="space-y-1 pl-1">
                  <Label
                    htmlFor="spoiler-words-per-caption"
                    className="text-xs text-muted-foreground"
                  >
                    Words per caption
                  </Label>
                  <Input
                    id="spoiler-words-per-caption"
                    type="number"
                    min={1}
                    max={MAX_WORDS_PER_CAPTION}
                    step={1}
                    value={wordsPerCaption}
                    disabled={isRunning}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      if (Number.isFinite(next)) {
                        setWordsPerCaption(clampWordsPerCaption(next))
                      }
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {wordsPerCaption === 1
                      ? '1 = karaoke (one word per clip).'
                      : `${wordsPerCaption} words per text clip. 5+ ≈ traditional caption.`}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-md border px-3 py-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-generate-cover-ai" className="text-sm">
                    Generate cover with AI
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Design a poster image first; it will be used as the cover for every produced
                    compound clip.
                  </p>
                </div>
                <Switch
                  id="spoiler-generate-cover-ai"
                  checked={generateCoverWithAi}
                  onCheckedChange={setGenerateCoverWithAi}
                />
              </div>
              {generateCoverWithAi && !imageGeneratorConfigured && (
                <p className="pl-1 text-xs text-amber-600 dark:text-amber-400">
                  Image Generator not configured. Open Settings → AI → Custom AI → Image Generator.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 'ai-cover' && (
          <div className="-mr-2 max-h-[calc(85vh-180px)] space-y-3 overflow-y-auto pr-2">
            <AiImagePanel
              key={aiPanelKey}
              width={canvasWidth}
              height={canvasHeight}
              promptMode="split"
              enableTranscriptSummarise
              imageGeneratorConfigured={imageGeneratorConfigured}
              imageGeneratorModel={imageGenerator.model}
              imageGeneratorBaseUrl={imageGenerator.baseUrl}
              visionAnalyzerConfigured={visionConfigured}
              controlledTitle={{ value: aiTitle, onChange: setAiTitle }}
              controlledTranscript={{ value: aiTranscript, onChange: setAiTranscript }}
              disabled={aiPrefillLoading}
              requireTranscript
              durationField={{
                valueSec: coverDurationSec,
                onChange: setCoverDurationSec,
                minSec: COVER_DURATION_BOUNDS.min,
                maxSec: COVER_DURATION_BOUNDS.max,
                step: 0.5,
                label: 'Cover duration (s)',
                helpText:
                  'How long the cover image plays at the start of every compound (and as a preroll before the opening narration in episode mode).',
              }}
              downloadFilenamePrefix={`spoiler-cover-${(mediaId ?? 'preview').slice(0, 8)}`}
              onImageGenerated={handleAiImageGenerated}
            />

            {aiPrefillLoading && (
              <p className="text-[11px] text-muted-foreground">Loading transcript from media…</p>
            )}
            {!aiPrefillLoading && !aiTranscriptLoaded && aiTranscript.trim().length === 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
                Source media has no transcript yet. Right-click the media → "Transcribe" first, then
                re-open this dialog.
              </p>
            )}

            {persistError && <Alert variant="error">{persistError}</Alert>}
            {persistedCover && (
              <Alert variant="success">
                Cover saved. Click "Generate Spoiler" to start the pipeline.
              </Alert>
            )}
          </div>
        )}

        {step === 'confirm' && (
          <div className="-mr-2 max-h-[calc(85vh-180px)] space-y-3 overflow-y-auto pr-2">
            <p className="text-xs text-muted-foreground">
              Review the configuration below. Once you confirm, the AI pipeline runs through
              transcription, scripting, narration, and assembly — typically 3-10 minutes depending
              on the source film length and provider speed.
            </p>

            <div className="rounded-md border px-3 py-3 space-y-3">
              <SummaryRow label="Source media" value={media?.fileName ?? '—'} />
              <SummaryRow
                label="Spoiler duration"
                value={
                  TARGET_DURATION_OPTIONS.find((o) => o.value === String(targetDurationSec))
                    ?.label ?? `${Math.round(targetDurationSec / 60)} minutes`
                }
              />
              <SummaryRow
                label="Narration"
                value={`${
                  NARRATION_LANGUAGE_OPTIONS.find((o) => o.value === narrationLanguage)?.label ??
                  narrationLanguage
                } @ ${ttsSpeed.toFixed(1)}×${voicePreset ? ` · voice: ${voicePreset}` : ''}`}
              />
              <SummaryRow label="Avg clip per segment" value={`${clipDurationSec}s (LLM hint)`} />
              <SummaryRow
                label="Subtitles"
                value={
                  addSubtitles
                    ? `On · ${clampWordsPerCaption(wordsPerCaption)} word(s) per caption`
                    : 'Off'
                }
              />

              <div className="border-t pt-3">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Episode mode
                </p>
                {episodeMode ? (
                  <div className="space-y-2">
                    <SummaryRow
                      label="Episode count"
                      value={`${effectiveEpisodeCount} (per-episode + 1 full = ${effectiveEpisodeCount + 1} compounds)`}
                    />
                    <SummaryRow
                      label="Per-episode bounds"
                      value={`${episodeMinDurationSec}s – ${episodeMaxDurationSec}s body`}
                    />
                    <SummaryRow
                      label="Boundary speed"
                      value={`${boundaryNarrationSpeed.toFixed(1)}× (opening/closing TTS)`}
                    />
                    <SummaryRow
                      label="Opening template"
                      value={episodeOpeningTemplate.trim() || '(none)'}
                      mono
                    />
                    <SummaryRow
                      label="Closing template"
                      value={episodeClosingTemplate.trim() || '(none)'}
                      mono
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Off · 1 full-duration compound only.
                  </p>
                )}
              </div>

              <div className="border-t pt-3">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Cover
                </p>
                {generateCoverWithAi ? (
                  persistedCover ? (
                    <div className="space-y-2">
                      <SummaryRow
                        label="Mode"
                        value={`AI-generated (${canvasWidth}×${canvasHeight})`}
                      />
                      <SummaryRow
                        label="Preroll duration"
                        value={`${coverDurationSec.toFixed(1)}s before opening narration`}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      AI cover not generated yet. Go back and click "Generate image".
                    </p>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">No cover.</p>
                )}
              </div>
            </div>

            {episodeMode && (
              <Alert variant="warning">
                The script writer must produce at least {effectiveEpisodeCount} segments to honor
                your episode count. If it returns fewer, the pipeline will stop with a clear error —
                you'll be able to lower the count and rerun without losing your settings.
              </Alert>
            )}
          </div>
        )}

        {step === 'progress' && (
          <div className="-mr-2 max-h-[calc(85vh-180px)] space-y-3 overflow-y-auto pr-2">
            {progress && (
              <div className="space-y-3">
                <p className="text-sm">{progress.message}</p>
                <SpoilerProgressStepper
                  currentStage={progress.stage as SpoilerStage}
                  showSubtitles={addSubtitles}
                  showCover={!!persistedCover}
                  episodeMode={episodeMode}
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
              <Button
                onClick={handlePrimary}
                disabled={
                  generateCoverWithAi
                    ? !canRunBase || !imageGeneratorConfigured
                    : !canRunWithoutAiCover
                }
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                {primaryButtonLabel}
              </Button>
            </>
          )}
          {step === 'ai-cover' && (
            <>
              <Button variant="ghost" onClick={() => setStep('settings')}>
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back
              </Button>
              <Button onClick={handlePrimary} disabled={!canRunWithAiCover}>
                Next: Review
              </Button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <Button variant="ghost" onClick={handleConfirmBack}>
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back
              </Button>
              <Button
                onClick={handlePrimary}
                disabled={generateCoverWithAi ? !canRunWithAiCover : !canRunWithoutAiCover}
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                Confirm &amp; Generate
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

interface SummaryRowProps {
  label: string
  value: React.ReactNode
  /** Render `value` in a monospace tone (used for prompt templates). */
  mono?: boolean
}

function SummaryRow(props: SummaryRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      <span
        className={
          props.mono
            ? 'min-w-0 break-words text-right font-mono text-[11px] text-foreground'
            : 'min-w-0 break-words text-right text-foreground'
        }
      >
        {props.value}
      </span>
    </div>
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
