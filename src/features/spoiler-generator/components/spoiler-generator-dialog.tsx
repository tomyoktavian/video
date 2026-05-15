import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Loader2, Sparkles, Square } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'

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
import { SliderInput } from '@/shared/ui/property-controls'
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
import {
  KOKORO_TTS_VOICE_OPTIONS,
  kokoroTtsService,
  MOSS_TTS_VOICE_OPTIONS,
  mossTtsService,
  SUPERTONIC_TTS_DEFAULT_LANGUAGE,
  SUPERTONIC_TTS_DEFAULT_QUALITY,
  SUPERTONIC_TTS_DEFAULT_VOICE,
  SUPERTONIC_TTS_LANGUAGES,
  SUPERTONIC_TTS_VOICE_OPTIONS,
  supertonicTtsService,
  type KokoroTtsVoice,
  type MossTtsVoice,
  type SupertonicTtsLanguage,
  type SupertonicTtsVoice,
} from '../deps/tts'
import { useProjectStore } from '../deps/project'
import { getTranscript } from '../deps/transcription'
import { substituteTemplate } from '../episode-narration-generator'
import { runSpoilerPipeline } from '../spoiler-orchestrator'
import type { SpoilerProgress, SpoilerStage } from '../types'
import type { SpoilerTtsEngine, SpoilerTtsEngineConfig } from '../tts-engine-adapter'
import { SpoilerProgressStepper } from './spoiler-progress-stepper'

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
  const { t } = useTranslation()
  const isOpen = useSpoilerGeneratorDialogStore((s) => s.isOpen)
  const mediaId = useSpoilerGeneratorDialogStore((s) => s.mediaId)
  const close = useSpoilerGeneratorDialogStore((s) => s.close)

  const targetDurationOptions: ComboboxOption[] = useMemo(
    () => [
      { value: '300', label: t('spoiler.dialog.duration5min') },
      { value: '600', label: t('spoiler.dialog.duration10min') },
      { value: '900', label: t('spoiler.dialog.duration15min') },
      { value: '1200', label: t('spoiler.dialog.duration20min') },
    ],
    [t],
  )

  const narrationLanguageOptions: ComboboxOption[] = useMemo(
    () => [
      { value: 'id', label: t('spoiler.dialog.langIndonesianDefault') },
      { value: 'en', label: t('spoiler.dialog.langEnglish') },
      { value: 'es', label: t('spoiler.dialog.langSpanish') },
      { value: 'ja', label: t('spoiler.dialog.langJapanese') },
      { value: 'ko', label: t('spoiler.dialog.langKorean') },
      { value: 'zh', label: t('spoiler.dialog.langChinese') },
    ],
    [t],
  )

  const ttsEngineOptions: ComboboxOption[] = useMemo(
    () => [
      { value: 'custom', label: t('spoiler.dialog.ttsEngineCustom') },
      { value: 'kokoro', label: t('spoiler.dialog.ttsEngineKokoro') },
      { value: 'supertonic', label: t('spoiler.dialog.ttsEngineSupertonic') },
      { value: 'moss', label: t('spoiler.dialog.ttsEngineMoss') },
    ],
    [t],
  )

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
  const [ttsEngine, setTtsEngine] = useState<SpoilerTtsEngine>('custom')
  const [voicePreset, setVoicePreset] = useState<string>('')
  const [kokoroVoice, setKokoroVoice] = useState<KokoroTtsVoice>('af_heart')
  const [supertonicVoice, setSupertonicVoice] = useState<SupertonicTtsVoice>(
    SUPERTONIC_TTS_DEFAULT_VOICE,
  )
  const [supertonicLanguage, setSupertonicLanguage] = useState<SupertonicTtsLanguage>(
    SUPERTONIC_TTS_DEFAULT_LANGUAGE,
  )
  const [supertonicQuality, setSupertonicQuality] = useState<number>(SUPERTONIC_TTS_DEFAULT_QUALITY)
  const [mossVoice, setMossVoice] = useState<MossTtsVoice>('Xiaoyu')
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
    setTtsEngine('custom')
    setVoicePreset(textToSpeech.voice || '')
    setKokoroVoice('af_heart')
    setSupertonicVoice(SUPERTONIC_TTS_DEFAULT_VOICE)
    setSupertonicLanguage(SUPERTONIC_TTS_DEFAULT_LANGUAGE)
    setSupertonicQuality(SUPERTONIC_TTS_DEFAULT_QUALITY)
    setMossVoice('Xiaoyu')
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

  const isKokoroSupported = kokoroTtsService.isSupported()
  const isSupertonicSupported = supertonicTtsService.isSupported()
  const isMossSupported = mossTtsService.isSupported()

  // Pick the engine-specific runtime label that surfaces in the summary +
  // unsupported banner. Custom AI flows through `voicePreset` (cached voice
  // list); local engines have their own typed voice unions. Memoised so the
  // startPipeline callback's dep array stays stable across re-renders.
  const engineConfig = useMemo<SpoilerTtsEngineConfig>(() => {
    if (ttsEngine === 'kokoro') return { engine: 'kokoro', voice: kokoroVoice }
    if (ttsEngine === 'supertonic') {
      return {
        engine: 'supertonic',
        voice: supertonicVoice,
        language: supertonicLanguage,
        quality: supertonicQuality,
      }
    }
    if (ttsEngine === 'moss') return { engine: 'moss', voice: mossVoice }
    return { engine: 'custom', ...(voicePreset ? { voice: voicePreset } : {}) }
  }, [
    kokoroVoice,
    mossVoice,
    supertonicLanguage,
    supertonicQuality,
    supertonicVoice,
    ttsEngine,
    voicePreset,
  ])

  const ttsEngineReady =
    ttsEngine === 'kokoro'
      ? isKokoroSupported
      : ttsEngine === 'supertonic'
        ? isSupertonicSupported
        : ttsEngine === 'moss'
          ? isMossSupported
          : ttsConfigured

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
    ttsEngineReady &&
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
        setPersistError(
          error instanceof Error ? error.message : t('spoiler.dialog.failedToSaveCover'),
        )
      }
    },
    [canvasHeight, canvasWidth, mediaId, t],
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
      setProgress({ stage: 'idle', message: t('spoiler.dialog.starting') })
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
            // Speed only configurable for Custom AI; local engines fall back
            // to provider default (1.0×).
            voiceSpeed: ttsEngine === 'custom' ? ttsSpeed : 1,
            ttsEngineConfig: engineConfig,
            ...(ttsEngine === 'custom' && voicePreset ? { voicePreset } : {}),
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
          setProgress({ stage: 'idle', message: t('spoiler.dialog.cancelled') })
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
      engineConfig,
      episodeClosingTemplate,
      episodeMaxDurationSec,
      episodeMinDurationSec,
      episodeMode,
      episodeOpeningTemplate,
      media,
      mediaId,
      narrationLanguage,
      setSetting,
      t,
      targetDurationSec,
      ttsEngine,
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
    if (step === 'settings')
      return generateCoverWithAi
        ? t('spoiler.dialog.primaryNextCover')
        : t('spoiler.dialog.primaryNextReview')
    if (step === 'ai-cover') return t('spoiler.dialog.primaryNextReview')
    if (step === 'confirm') return t('spoiler.dialog.primaryConfirm')
    return t('spoiler.dialog.primaryGenerate')
  }, [generateCoverWithAi, step, t])

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
        className="max-w-2xl"
        onEscapeKeyDown={(event) => {
          if (isRunning) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('spoiler.dialog.title')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('spoiler.dialog.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        {step === 'settings' && (
          <div className="-mr-2 max-h-[calc(85vh-180px)] space-y-3 overflow-y-auto pr-2">
            {!media && <Alert variant="error">{t('spoiler.dialog.mediaNotFound')}</Alert>}

            {media && !captionConfigured && (
              <Alert variant="error">
                <Trans
                  i18nKey="spoiler.dialog.captionNotConfigured"
                  components={{ strong: <strong /> }}
                />
              </Alert>
            )}

            {media && !visionConfigured && (
              <Alert variant="error">
                <Trans
                  i18nKey="spoiler.dialog.visionNotConfigured"
                  components={{ strong: <strong /> }}
                />
              </Alert>
            )}

            {media && ttsEngine === 'custom' && !ttsConfigured && (
              <Alert variant="error">
                <Trans
                  i18nKey="spoiler.dialog.ttsNotConfigured"
                  components={{ strong: <strong /> }}
                />
              </Alert>
            )}

            {media && ttsEngine === 'kokoro' && !isKokoroSupported && (
              <Alert variant="error">{t('spoiler.dialog.kokoroUnsupported')}</Alert>
            )}

            {media && ttsEngine === 'supertonic' && !isSupertonicSupported && (
              <Alert variant="error">{t('spoiler.dialog.supertonicUnsupported')}</Alert>
            )}

            {media && ttsEngine === 'moss' && !isMossSupported && (
              <Alert variant="error">{t('spoiler.dialog.mossUnsupported')}</Alert>
            )}

            {media && !transcriptReady && (
              <Alert variant="warning">{t('spoiler.dialog.transcriptNotReady')}</Alert>
            )}

            <div className="space-y-1.5">
              <Label className="text-sm">{t('spoiler.dialog.spoilerDuration')}</Label>
              <Combobox
                value={String(targetDurationSec)}
                options={targetDurationOptions}
                onValueChange={(value) => setTargetDurationSec(Number(value))}
                placeholder={t('spoiler.dialog.selectDuration')}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">{t('spoiler.dialog.narrationLanguage')}</Label>
              <Combobox
                value={narrationLanguage}
                options={narrationLanguageOptions}
                onValueChange={setNarrationLanguage}
                placeholder={t('spoiler.dialog.selectLanguage')}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">{t('spoiler.dialog.ttsEngine')}</Label>
              <Combobox
                value={ttsEngine}
                options={ttsEngineOptions}
                onValueChange={(value) => setTtsEngine(value as SpoilerTtsEngine)}
                placeholder={t('spoiler.dialog.selectEngine')}
              />
              <p className="text-xs text-muted-foreground">{t('spoiler.dialog.engineHelp')}</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">{t('spoiler.dialog.clipDuration')}</Label>
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
                {t('spoiler.dialog.clipDurationHelp')}
              </p>
            </div>

            {ttsEngine === 'custom' && voiceOptions.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-sm">{t('spoiler.dialog.narrationVoice')}</Label>
                <Combobox
                  value={voicePreset}
                  options={voiceOptions}
                  onValueChange={setVoicePreset}
                  placeholder={t('spoiler.dialog.voicePlaceholderCustom')}
                  searchPlaceholder={t('spoiler.dialog.searchVoices')}
                  emptyMessage={t('spoiler.dialog.emptyVoices')}
                />
              </div>
            )}

            {ttsEngine === 'kokoro' && (
              <div className="space-y-1.5">
                <Label className="text-sm">{t('spoiler.dialog.narrationVoice')}</Label>
                <Combobox
                  value={kokoroVoice}
                  options={KOKORO_TTS_VOICE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onValueChange={(value) => setKokoroVoice(value as KokoroTtsVoice)}
                  placeholder={t('spoiler.dialog.voicePlaceholderKokoro')}
                  searchPlaceholder={t('spoiler.dialog.searchVoices')}
                />
              </div>
            )}

            {ttsEngine === 'supertonic' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('spoiler.dialog.narrationVoice')}</Label>
                  <Combobox
                    value={supertonicVoice}
                    options={SUPERTONIC_TTS_VOICE_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    onValueChange={(value) => setSupertonicVoice(value as SupertonicTtsVoice)}
                    placeholder={t('spoiler.dialog.voicePlaceholderSupertonic')}
                    searchPlaceholder={t('spoiler.dialog.searchVoices')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('spoiler.dialog.supertonicLanguage')}</Label>
                  <Combobox
                    value={supertonicLanguage}
                    options={SUPERTONIC_TTS_LANGUAGES.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                    onValueChange={(value) => setSupertonicLanguage(value as SupertonicTtsLanguage)}
                    placeholder={t('spoiler.dialog.selectLanguage')}
                    searchPlaceholder={t('spoiler.dialog.searchLanguages')}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('spoiler.dialog.supertonicLanguageHelp')}
                  </p>
                </div>
              </>
            )}

            {ttsEngine === 'moss' && (
              <div className="space-y-1.5">
                <Label className="text-sm">{t('spoiler.dialog.narrationVoice')}</Label>
                <Combobox
                  value={mossVoice}
                  options={MOSS_TTS_VOICE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onValueChange={(value) => setMossVoice(value as MossTtsVoice)}
                  placeholder={t('spoiler.dialog.voicePlaceholderMoss')}
                  searchPlaceholder={t('spoiler.dialog.searchVoices')}
                />
              </div>
            )}

            {ttsEngine === 'custom' && (
              <div className="space-y-1.5">
                <SliderInput
                  label={t('spoiler.dialog.narrationSpeed')}
                  value={ttsSpeed}
                  onChange={(value) => {
                    if (Number.isFinite(value)) {
                      setTtsSpeed(
                        Math.min(TTS_SPEED_BOUNDS.max, Math.max(TTS_SPEED_BOUNDS.min, value)),
                      )
                    }
                  }}
                  min={TTS_SPEED_BOUNDS.min}
                  max={TTS_SPEED_BOUNDS.max}
                  step={0.05}
                  unit="x"
                  disabled={isRunning}
                />
                <p className="text-xs text-muted-foreground">{t('spoiler.dialog.speedHelp')}</p>
              </div>
            )}

            <div className="rounded-md border px-3 py-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-episode-mode" className="text-sm">
                    {t('spoiler.dialog.episodeMode')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('spoiler.dialog.episodeModeHelp')}
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
                        {t('spoiler.dialog.minDuration')}
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
                        {t('spoiler.dialog.maxDuration')}
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
                      {t('spoiler.dialog.episodeCount')}
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
                      {t('spoiler.dialog.episodeCountHelp', { count: autoEpisodeCount })}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label
                      htmlFor="spoiler-episode-opening"
                      className="text-xs text-muted-foreground"
                    >
                      {t('spoiler.dialog.openingTemplate')}
                    </Label>
                    <Textarea
                      id="spoiler-episode-opening"
                      rows={2}
                      value={episodeOpeningTemplate}
                      disabled={isRunning}
                      onChange={(event) => setEpisodeOpeningTemplate(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      <Trans
                        i18nKey="spoiler.dialog.openingTemplateHelp"
                        values={{ nToken: '{n}', nextToken: '{next}' }}
                        components={{ 1: <code />, 2: <code /> }}
                      />
                    </p>
                    {episodeOpeningTemplate.trim() && (
                      <p className="text-xs italic text-muted-foreground">
                        {t('spoiler.dialog.openingPreview', {
                          text: substituteTemplate(episodeOpeningTemplate, { n: 2, next: 3 }),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label
                      htmlFor="spoiler-episode-closing"
                      className="text-xs text-muted-foreground"
                    >
                      {t('spoiler.dialog.closingTemplate')}
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
                        {t('spoiler.dialog.closingPreview', {
                          text: substituteTemplate(episodeClosingTemplate, { n: 1, next: 2 }),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label
                      htmlFor="spoiler-boundary-speed"
                      className="text-xs text-muted-foreground"
                    >
                      {t('spoiler.dialog.boundarySpeed')}
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
                      {t('spoiler.dialog.boundarySpeedHelp')}
                    </p>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {t('spoiler.dialog.episodeBoundaryNote')}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-md border px-3 py-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-add-subtitles" className="text-sm">
                    {t('spoiler.dialog.subtitles')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('spoiler.dialog.subtitlesHelp')}
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
                    {t('spoiler.dialog.wordsPerCaption')}
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
                      ? t('spoiler.dialog.wordsPerCaptionKaraoke')
                      : t('spoiler.dialog.wordsPerCaptionDescription', { count: wordsPerCaption })}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-md border px-3 py-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="spoiler-generate-cover-ai" className="text-sm">
                    {t('spoiler.dialog.generateCoverAi')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('spoiler.dialog.generateCoverAiHelp')}
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
                  {t('spoiler.dialog.imageGeneratorWarning')}
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
                label: t('spoiler.dialog.coverDurationLabel'),
                helpText: t('spoiler.dialog.coverDurationHelp'),
              }}
              downloadFilenamePrefix={`spoiler-cover-${(mediaId ?? 'preview').slice(0, 8)}`}
              onImageGenerated={handleAiImageGenerated}
            />

            {aiPrefillLoading && (
              <p className="text-[11px] text-muted-foreground">
                {t('spoiler.dialog.loadingTranscript')}
              </p>
            )}
            {!aiPrefillLoading && !aiTranscriptLoaded && aiTranscript.trim().length === 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
                {t('spoiler.dialog.noTranscriptWarning')}
              </p>
            )}

            {persistError && <Alert variant="error">{persistError}</Alert>}
            {persistedCover && <Alert variant="success">{t('spoiler.dialog.coverSaved')}</Alert>}
          </div>
        )}

        {step === 'confirm' && (
          <div className="-mr-2 max-h-[calc(85vh-180px)] space-y-3 overflow-y-auto pr-2">
            <p className="text-xs text-muted-foreground">{t('spoiler.dialog.confirmIntro')}</p>

            <div className="rounded-md border px-3 py-3 space-y-3">
              <SummaryRow
                label={t('spoiler.dialog.summarySourceMedia')}
                value={media?.fileName ?? '—'}
              />
              <SummaryRow
                label={t('spoiler.dialog.summarySpoilerDuration')}
                value={
                  targetDurationOptions.find((o) => o.value === String(targetDurationSec))?.label ??
                  t('spoiler.dialog.minutesFallback', {
                    count: Math.round(targetDurationSec / 60),
                  })
                }
              />
              <SummaryRow
                label={t('spoiler.dialog.summaryNarration')}
                value={`${
                  narrationLanguageOptions.find((o) => o.value === narrationLanguage)?.label ??
                  narrationLanguage
                }${ttsEngine === 'custom' ? ` @ ${ttsSpeed.toFixed(1)}×` : ''}`}
              />
              <SummaryRow
                label={t('spoiler.dialog.summaryTtsEngine')}
                value={
                  ttsEngine === 'kokoro'
                    ? `Kokoro · ${kokoroVoice}`
                    : ttsEngine === 'supertonic'
                      ? `Supertonic 3 · ${supertonicVoice} · ${supertonicLanguage}`
                      : ttsEngine === 'moss'
                        ? `MOSS Nano · ${mossVoice}`
                        : `Custom AI${voicePreset ? ` · ${voicePreset}` : ''}`
                }
              />
              <SummaryRow
                label={t('spoiler.dialog.summaryAvgClip')}
                value={t('spoiler.dialog.summaryAvgClipValue', { seconds: clipDurationSec })}
              />
              <SummaryRow
                label={t('spoiler.dialog.summarySubtitles')}
                value={
                  addSubtitles
                    ? t('spoiler.dialog.summarySubtitlesOn', {
                        count: clampWordsPerCaption(wordsPerCaption),
                      })
                    : t('spoiler.dialog.summarySubtitlesOff')
                }
              />

              <div className="border-t pt-3">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('spoiler.dialog.summaryEpisodeMode')}
                </p>
                {episodeMode ? (
                  <div className="space-y-2">
                    <SummaryRow
                      label={t('spoiler.dialog.summaryEpisodeCount')}
                      value={t('spoiler.dialog.summaryEpisodeCountValue', {
                        count: effectiveEpisodeCount,
                        total: effectiveEpisodeCount + 1,
                      })}
                    />
                    <SummaryRow
                      label={t('spoiler.dialog.summaryPerEpisodeBounds')}
                      value={t('spoiler.dialog.summaryPerEpisodeBoundsValue', {
                        min: episodeMinDurationSec,
                        max: episodeMaxDurationSec,
                      })}
                    />
                    <SummaryRow
                      label={t('spoiler.dialog.summaryBoundarySpeed')}
                      value={t('spoiler.dialog.summaryBoundarySpeedValue', {
                        speed: boundaryNarrationSpeed.toFixed(1),
                      })}
                    />
                    <SummaryRow
                      label={t('spoiler.dialog.summaryOpeningTemplate')}
                      value={
                        episodeOpeningTemplate.trim() || t('spoiler.dialog.summaryTemplateNone')
                      }
                      mono
                    />
                    <SummaryRow
                      label={t('spoiler.dialog.summaryClosingTemplate')}
                      value={
                        episodeClosingTemplate.trim() || t('spoiler.dialog.summaryTemplateNone')
                      }
                      mono
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('spoiler.dialog.summaryEpisodeOff')}
                  </p>
                )}
              </div>

              <div className="border-t pt-3">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('spoiler.dialog.summaryCover')}
                </p>
                {generateCoverWithAi ? (
                  persistedCover ? (
                    <div className="space-y-2">
                      <SummaryRow
                        label={t('spoiler.dialog.summaryCoverMode')}
                        value={t('spoiler.dialog.summaryCoverModeAi', {
                          width: canvasWidth,
                          height: canvasHeight,
                        })}
                      />
                      <SummaryRow
                        label={t('spoiler.dialog.summaryPrerollDuration')}
                        value={t('spoiler.dialog.summaryPrerollDurationValue', {
                          seconds: coverDurationSec.toFixed(1),
                        })}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {t('spoiler.dialog.summaryCoverNotGenerated')}
                    </p>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('spoiler.dialog.summaryNoCover')}
                  </p>
                )}
              </div>
            </div>

            {episodeMode && (
              <Alert variant="warning">
                {t('spoiler.dialog.episodeCountWarning', { count: effectiveEpisodeCount })}
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
                      {t('spoiler.dialog.segmentProgress', {
                        current: progress.segmentIndex,
                        total: progress.segmentTotal,
                      })}
                    </p>
                  )}
              </div>
            )}
            {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
            {progress?.stage === 'done' && !errorMessage && (
              <Alert variant="success">{t('spoiler.dialog.spoilerReady')}</Alert>
            )}
          </div>
        )}

        <AlertDialogFooter>
          {step === 'settings' && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                {t('spoiler.dialog.cancel')}
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
                {t('spoiler.dialog.back')}
              </Button>
              <Button onClick={handlePrimary} disabled={!canRunWithAiCover}>
                {t('spoiler.dialog.primaryNextReview')}
              </Button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <Button variant="ghost" onClick={handleConfirmBack}>
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                {t('spoiler.dialog.back')}
              </Button>
              <Button
                onClick={handlePrimary}
                disabled={generateCoverWithAi ? !canRunWithAiCover : !canRunWithoutAiCover}
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                {t('spoiler.dialog.primaryConfirm')}
              </Button>
            </>
          )}
          {step === 'progress' && (
            <>
              {isRunning && (
                <Button variant="ghost" onClick={handleCancelRun}>
                  <Square className="mr-1.5 h-4 w-4" />
                  {t('spoiler.dialog.cancel')}
                </Button>
              )}
              {!isRunning && (
                <>
                  <Button variant="ghost" onClick={() => setStep('settings')}>
                    {t('spoiler.dialog.back')}
                  </Button>
                  <Button onClick={handleClose}>{t('spoiler.dialog.close')}</Button>
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
