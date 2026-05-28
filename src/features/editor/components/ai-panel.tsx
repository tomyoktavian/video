import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  ChevronDown,
  Download,
  Info,
  Layers,
  ListPlus,
  Loader2,
  Pause,
  Play,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { getMusicgenModelDefinition } from '@/shared/utils/musicgen-models'
import {
  getStoredTtsEngine,
  setStoredTtsEngine,
  type StoredTtsEngine,
} from '@/shared/utils/tts-settings'
import { SliderInput } from '@/shared/ui/property-controls'
import { cn } from '@/shared/ui/cn'
import { i18n } from '@/i18n'
import {
  importMediaLibraryService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import {
  isImageGeneratorConfigured,
  isTextToSpeechConfigured,
  useCustomAiStore,
} from '@/features/editor/deps/settings-contract'
import {
  AiImagePanel,
  pickAspectRatioFromCanvas,
  resolveImageDimensions,
  type AiImageGeneratedPayload,
} from '@/features/editor/deps/compound-cover'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useSetCoverToCompoundsDialogStore } from '@/shared/state/set-cover-to-compounds-dialog'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import {
  findCompatibleTrackForItemType,
  findNearestAvailableSpace,
} from '@/features/editor/deps/timeline-utils'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import type { AudioItem } from '@/types/timeline'
import type { MediaMetadata } from '@/types/storage'
import {
  KOKORO_TTS_BEST_MODEL,
  KOKORO_TTS_VOICE_OPTIONS,
  getKokoroTtsModelOption,
  getKokoroTtsVoiceOption,
  kokoroTtsService,
  type KokoroTtsModel,
  type KokoroTtsVoice,
} from '../services/kokoro-tts-service'
import {
  MOSS_TTS_VOICE_OPTIONS,
  getMossTtsVoiceOption,
  mossTtsService,
  type MossTtsVoice,
} from '../services/moss-tts-service'
import {
  SUPERTONIC_TTS_DEFAULT_LANGUAGE,
  SUPERTONIC_TTS_DEFAULT_QUALITY,
  SUPERTONIC_TTS_DEFAULT_VOICE,
  SUPERTONIC_TTS_LANGUAGES,
  SUPERTONIC_TTS_QUALITY_MAX,
  SUPERTONIC_TTS_QUALITY_MIN,
  SUPERTONIC_TTS_VOICE_OPTIONS,
  getSupertonicTtsLanguageOption,
  getSupertonicTtsVoiceOption,
  supertonicTtsService,
  type SupertonicTtsLanguage,
  type SupertonicTtsVoice,
} from '../services/supertonic-tts-service'
import {
  DEFAULT_MUSICGEN_MODEL,
  MUSICGEN_MODEL_OPTIONS,
  musicgenService,
  type MusicgenModelId,
} from '../services/musicgen-service'
import { customTtsService } from '../services/custom-tts-service'

const MUSIC_PROMPT_PRESETS = [
  {
    labelKey: 'editor.aiPanel.musicPresets.lofiChillLabel',
    promptKey: 'editor.aiPanel.musicPresets.lofiChillPrompt',
  },
  {
    labelKey: 'editor.aiPanel.musicPresets.pop80sLabel',
    promptKey: 'editor.aiPanel.musicPresets.pop80sPrompt',
  },
  {
    labelKey: 'editor.aiPanel.musicPresets.rock90sLabel',
    promptKey: 'editor.aiPanel.musicPresets.rock90sPrompt',
  },
  {
    labelKey: 'editor.aiPanel.musicPresets.upbeatEdmLabel',
    promptKey: 'editor.aiPanel.musicPresets.upbeatEdmPrompt',
  },
  {
    labelKey: 'editor.aiPanel.musicPresets.countryLabel',
    promptKey: 'editor.aiPanel.musicPresets.countryPrompt',
  },
  {
    labelKey: 'editor.aiPanel.musicPresets.lofiElectroLabel',
    promptKey: 'editor.aiPanel.musicPresets.lofiElectroPrompt',
  },
]

const DEFAULT_IMAGE_PROMPT =
  'A cinematic photograph of a lone figure walking down a rain-soaked alleyway at night, neon signs reflecting in the puddles.'

interface ImageGeneration {
  id: string
  file: File
  blob: Blob
  objectUrl: string
  byteSize: number
  width: number
  height: number
  promptSnippet: string
  details: string
  tags: string[]
  /** null = unsaved, string = saved media ID */
  savedMediaId: string | null
  saving: boolean
}

interface AudioGeneration {
  id: string
  file: File
  objectUrl: string
  byteSize: number
  duration: number
  textSnippet: string
  voice: string
  model: string
  summary: string
  details: string
  tags: string[]
  /** null = unsaved, string = saved media ID */
  savedMediaId: string | null
  saving: boolean
}

type Generation = AudioGeneration

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const MiniAudioPlayer = memo(function MiniAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isSeeking, setIsSeeking] = useState(false)
  const isSeekingRef = useRef(false)
  isSeekingRef.current = isSeeking

  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onTimeUpdate = () => {
      if (!isSeekingRef.current) setCurrentTime(el.currentTime)
    }
    const onLoaded = () => setDuration(el.duration)
    const onEnded = () => {
      setIsPlaying(false)
      setCurrentTime(0)
    }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('ended', onEnded)

    return () => {
      el.pause()
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('loadedmetadata', onLoaded)
      el.removeEventListener('ended', onEnded)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      void el.play()
    } else {
      el.pause()
    }
  }, [])

  const handleSeek = useCallback(
    (values: number[]) => {
      const el = audioRef.current
      if (!el || !duration) return
      const time = ((values[0] ?? 0) / 100) * duration
      el.currentTime = time
      setCurrentTime(time)
    },
    [duration],
  )

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/30 px-1.5 py-1">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm glow-primary-sm transition-colors hover:bg-primary/90"
        onClick={togglePlay}
        aria-label={isPlaying ? i18n.t('preview.player.pause') : i18n.t('preview.player.play')}
      >
        {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3 ml-px" />}
      </button>
      <Slider
        value={[progressPercent]}
        onValueChange={(values) => {
          setIsSeeking(true)
          handleSeek(values)
        }}
        onValueCommit={() => setIsSeeking(false)}
        max={100}
        step={0.1}
        className="min-w-0 flex-1"
        aria-label={i18n.t('editor.tts.seek')}
      />
      <span className="shrink-0 select-none font-mono text-[10px] tabular-nums text-muted-foreground">
        {formatTime(currentTime)}
        <span className="text-muted-foreground/40"> / </span>
        {formatTime(duration)}
      </span>
    </div>
  )
})

function insertAudioItemAtPlayhead(media: MediaMetadata, blobUrl: string): boolean {
  const { tracks, items, fps, addItem } = useTimelineStore.getState()
  const { activeTrackId, selectItems } = useSelectionStore.getState()

  const targetTrack = findCompatibleTrackForItemType({
    tracks,
    items,
    itemType: 'audio',
    preferredTrackId: activeTrackId,
  })

  if (!targetTrack) return false

  const sourceFps = media.fps || fps
  const durationInFrames = Math.max(1, Math.round(media.duration * fps))
  const sourceDurationFrames = Math.round(media.duration * sourceFps)

  const proposedPosition = usePlaybackStore.getState().currentFrame
  const finalPosition =
    findNearestAvailableSpace(proposedPosition, durationInFrames, targetTrack.id, items) ??
    proposedPosition

  const audioItem: AudioItem = {
    id: crypto.randomUUID(),
    type: 'audio',
    trackId: targetTrack.id,
    from: finalPosition,
    durationInFrames,
    label: media.fileName,
    mediaId: media.id,
    originId: crypto.randomUUID(),
    src: blobUrl,
    sourceStart: 0,
    sourceEnd: sourceDurationFrames,
    sourceDuration: sourceDurationFrames,
    sourceFps,
    trimStart: 0,
    trimEnd: 0,
  }

  addItem(audioItem)

  // addItem may silently drop the item if placement fails; verify it landed.
  const added = useTimelineStore.getState().items.some((i) => i.id === audioItem.id)
  if (added) {
    selectItems([audioItem.id])
  }
  return added
}

export const AiPanel = memo(function AiPanel() {
  const { t } = useTranslation()
  const currentProjectId = useMediaLibraryStore((state) => state.currentProjectId)
  const loadMediaItems = useMediaLibraryStore((state) => state.loadMediaItems)
  const selectMedia = useMediaLibraryStore((state) => state.selectMedia)
  const showNotification = useMediaLibraryStore((state) => state.showNotification)

  const customTtsConfig = useCustomAiStore((s) => s.textToSpeech)
  const isCustomTtsConfigured = isTextToSpeechConfigured(customTtsConfig)
  const imageGeneratorConfig = useCustomAiStore((s) => s.imageGenerator)
  const isCustomImageGeneratorConfigured = isImageGeneratorConfigured(imageGeneratorConfig)

  const [ttsText, setTtsText] = useState(() => t('editor.aiPanel.defaultTtsPrompt'))
  const [ttsEngine, setTtsEngine] = useState<StoredTtsEngine>(() =>
    // First-run users with Custom TTS configured default to 'custom'; otherwise
    // Supertonic is the default local engine. Users who previously chose
    // another engine keep their stored preference.
    getStoredTtsEngine(isCustomTtsConfigured ? 'custom' : 'supertonic'),
  )
  const [ttsKokoroVoice, setTtsKokoroVoice] = useState<KokoroTtsVoice>('af_heart')
  const [ttsMossVoice, setTtsMossVoice] = useState<MossTtsVoice>('Xiaoyu')
  const [ttsSupertonicVoice, setTtsSupertonicVoice] = useState<SupertonicTtsVoice>(
    SUPERTONIC_TTS_DEFAULT_VOICE,
  )
  const [ttsSupertonicLanguage, setTtsSupertonicLanguage] = useState<SupertonicTtsLanguage>(
    SUPERTONIC_TTS_DEFAULT_LANGUAGE,
  )
  const [ttsSupertonicQuality, setTtsSupertonicQuality] = useState<number>(
    SUPERTONIC_TTS_DEFAULT_QUALITY,
  )
  const ttsModel: KokoroTtsModel = KOKORO_TTS_BEST_MODEL
  const [ttsSpeed, setTtsSpeed] = useState(1)
  const [isTtsGenerating, setIsTtsGenerating] = useState(false)
  const [ttsProgress, setTtsProgress] = useState<string | null>(null)
  const [ttsError, setTtsError] = useState<string | null>(null)
  const [ttsGenerations, setTtsGenerations] = useState<AudioGeneration[]>([])
  const [ttsSectionOpen, setTtsSectionOpen] = useState(true)

  const [musicPrompt, setMusicPrompt] = useState(() => t(MUSIC_PROMPT_PRESETS[0]!.promptKey))
  const [musicModel] = useState<MusicgenModelId>(DEFAULT_MUSICGEN_MODEL)
  const currentMusicModel = useMemo(() => getMusicgenModelDefinition(musicModel), [musicModel])
  const [musicDuration, setMusicDuration] = useState(currentMusicModel.defaultDurationSeconds)
  const [isMusicGenerating, setIsMusicGenerating] = useState(false)
  const [musicProgress, setMusicProgress] = useState<string | null>(null)
  const [musicError, setMusicError] = useState<string | null>(null)
  const [musicGenerations, setMusicGenerations] = useState<AudioGeneration[]>([])
  const [musicProgressPct, setMusicProgressPct] = useState<number | null>(null)
  const [musicInfoOpen, setMusicInfoOpen] = useState(false)
  const [musicSectionOpen, setMusicSectionOpen] = useState(true)

  // --- Image Generation state (Custom AI Image Generator). ---
  // Form state (prompt, aspect, taste fields) lives inside <AiImagePanel>;
  // this section only owns the multi-shot history list of saved generations.
  const projectMetadata = useProjectStore((s) => s.currentProject?.metadata)
  const projectCanvasWidth = projectMetadata?.width ?? 1024
  const projectCanvasHeight = projectMetadata?.height ?? 1024
  const defaultImageAspect = useMemo(
    () => pickAspectRatioFromCanvas(projectCanvasWidth, projectCanvasHeight),
    [projectCanvasWidth, projectCanvasHeight],
  )
  const [imageGenerations, setImageGenerations] = useState<ImageGeneration[]>([])
  const [imageSaveError, setImageSaveError] = useState<string | null>(null)
  const [imageSectionOpen, setImageSectionOpen] = useState(true)

  const musicAbortRef = useRef<AbortController | null>(null)
  const ttsTextareaRef = useRef<HTMLTextAreaElement>(null)
  const generationUrlsRef = useRef<Set<string>>(new Set())

  // Revoke all blob URLs on unmount
  useEffect(() => {
    setMusicDuration((previous) =>
      Math.min(
        currentMusicModel.maxDurationSeconds,
        Math.max(currentMusicModel.minDurationSeconds, previous),
      ),
    )
  }, [currentMusicModel.maxDurationSeconds, currentMusicModel.minDurationSeconds])

  // Abort in-flight generation and revoke all blob URLs on unmount
  useEffect(() => {
    const urls = generationUrlsRef.current
    return () => {
      musicAbortRef.current?.abort()
      musicAbortRef.current = null
      for (const url of urls) {
        URL.revokeObjectURL(url)
      }
    }
  }, [])

  useEffect(() => {
    setStoredTtsEngine(ttsEngine)
  }, [ttsEngine])

  const isKokoroSupported = kokoroTtsService.isSupported()
  const isMossSupported = mossTtsService.isSupported()
  const isSupertonicSupported = supertonicTtsService.isSupported()
  const isCustomTtsEngine = ttsEngine === 'custom'
  const supportsNativeTtsSpeed =
    ttsEngine === 'kokoro' || ttsEngine === 'supertonic' || isCustomTtsEngine
  const ttsSpeedMin = ttsEngine === 'supertonic' ? 0.8 : 0.5
  const ttsSpeedMax = ttsEngine === 'supertonic' ? 1.3 : 2

  useEffect(() => {
    setTtsSpeed((current) => Math.min(ttsSpeedMax, Math.max(ttsSpeedMin, current)))
  }, [ttsSpeedMax, ttsSpeedMin])

  const effectiveTtsSpeed = supportsNativeTtsSpeed ? ttsSpeed : 1
  const isTtsSupported =
    ttsEngine === 'kokoro'
      ? isKokoroSupported
      : ttsEngine === 'supertonic'
        ? isSupertonicSupported
        : ttsEngine === 'moss'
          ? isMossSupported
          : isCustomTtsConfigured && customTtsService.isSupported()
  const isMusicSupported = musicgenService.isSupported()
  const trimmedTtsText = ttsText.trim()
  const trimmedMusicPrompt = musicPrompt.trim()

  const totalTtsBytes = useMemo(
    () => ttsGenerations.reduce((sum, generation) => sum + generation.byteSize, 0),
    [ttsGenerations],
  )

  const totalMusicBytes = useMemo(
    () => musicGenerations.reduce((sum, generation) => sum + generation.byteSize, 0),
    [musicGenerations],
  )

  const anyTtsSaving = ttsGenerations.some((generation) => generation.saving)
  const anyMusicSaving = musicGenerations.some((generation) => generation.saving)
  const text = ttsText
  const setText = setTtsText
  const voice =
    ttsEngine === 'kokoro'
      ? ttsKokoroVoice
      : ttsEngine === 'supertonic'
        ? ttsSupertonicVoice
        : ttsEngine === 'moss'
          ? ttsMossVoice
          : ''
  const speed = ttsSpeed
  const setSpeed = setTtsSpeed
  const isGenerating = isTtsGenerating
  const progress = ttsProgress
  const error = ttsError
  const generations = ttsGenerations
  const totalBytes = totalTtsBytes
  const anySaving = anyTtsSaving
  const trimmedText = trimmedTtsText
  const currentTtsBackendLabel =
    ttsEngine === 'kokoro'
      ? 'WebGPU'
      : ttsEngine === 'supertonic'
        ? 'WebGPU/WASM'
        : ttsEngine === 'moss'
          ? 'CPU'
          : 'Network'
  const currentTtsRuntimeLabel =
    ttsEngine === 'kokoro'
      ? 'Kokoro TTS Best'
      : ttsEngine === 'supertonic'
        ? 'Supertonic 3'
        : ttsEngine === 'moss'
          ? 'MOSS Nano'
          : 'Custom AI'

  // --- actions ---

  const handleTtsGenerate = useCallback(async () => {
    if (!currentProjectId) {
      setTtsError(t('editor.tts.errors.openProject'))
      return
    }
    if (!trimmedTtsText) {
      setTtsError(t('editor.tts.errors.enterText'))
      return
    }
    if (!isTtsSupported) {
      setTtsError(
        ttsEngine === 'kokoro'
          ? t('editor.tts.errors.kokoroUnsupported')
          : ttsEngine === 'supertonic'
            ? t('editor.tts.errors.supertonicUnsupported', {
                defaultValue:
                  'Supertonic 3 needs a browser with Web Worker + Cache Storage. Try a recent Chromium browser, Firefox, or Safari.',
              })
            : ttsEngine === 'moss'
              ? t('editor.tts.errors.mossUnsupported')
              : 'Custom AI TTS is not configured. Open Settings → AI → Custom AI → Text to Speech.',
      )
      return
    }

    setTtsError(null)
    setIsTtsGenerating(true)
    setTtsProgress(
      ttsEngine === 'custom' ? 'Calling Custom AI TTS...' : t('editor.tts.progressPreparing'),
    )

    try {
      const result =
        ttsEngine === 'kokoro'
          ? await kokoroTtsService.generateSpeechFile({
              text: trimmedTtsText,
              voice: ttsKokoroVoice,
              speed: effectiveTtsSpeed,
              model: ttsModel,
              onProgress: setTtsProgress,
            })
          : ttsEngine === 'supertonic'
            ? await supertonicTtsService.generateSpeechFile({
                text: trimmedTtsText,
                voice: ttsSupertonicVoice,
                language: ttsSupertonicLanguage,
                speed: effectiveTtsSpeed,
                quality: ttsSupertonicQuality,
                onProgress: setTtsProgress,
              })
            : ttsEngine === 'moss'
              ? await mossTtsService.generateSpeechFile({
                  text: trimmedTtsText,
                  voice: ttsMossVoice,
                  speed: effectiveTtsSpeed,
                  onProgress: setTtsProgress,
                })
              : await customTtsService.generateSpeechFile({
                  text: trimmedTtsText,
                  speed: effectiveTtsSpeed,
                  onProgress: setTtsProgress,
                })

      const { blob, file, duration } = result

      const objectUrl = URL.createObjectURL(blob)
      generationUrlsRef.current.add(objectUrl)
      const customVoiceLabel = customTtsConfig.voice.trim() || 'alloy'
      const voiceLabel =
        ttsEngine === 'kokoro'
          ? getKokoroTtsVoiceOption(ttsKokoroVoice).label
          : ttsEngine === 'supertonic'
            ? getSupertonicTtsVoiceOption(ttsSupertonicVoice).label
            : ttsEngine === 'moss'
              ? getMossTtsVoiceOption(ttsMossVoice).label
              : customVoiceLabel
      const modelLabel =
        ttsEngine === 'kokoro'
          ? getKokoroTtsModelOption(ttsModel).label
          : ttsEngine === 'supertonic'
            ? `Supertonic 3 (${getSupertonicTtsLanguageOption(ttsSupertonicLanguage).label})`
            : ttsEngine === 'moss'
              ? 'Multilingual Nano'
              : customTtsConfig.model || 'Custom AI'
      const engineTags =
        ttsEngine === 'kokoro'
          ? [
              'ai-generated',
              'kokoro-tts',
              'tts-engine:kokoro',
              `kokoro-quality:${ttsModel}`,
              `kokoro-voice:${ttsKokoroVoice}`,
            ]
          : ttsEngine === 'supertonic'
            ? [
                'ai-generated',
                'supertonic-tts',
                'tts-engine:supertonic',
                `supertonic-voice:${ttsSupertonicVoice}`,
                `supertonic-lang:${ttsSupertonicLanguage}`,
                `supertonic-quality:${ttsSupertonicQuality}`,
              ]
            : ttsEngine === 'moss'
              ? ['ai-generated', 'moss-tts', 'tts-engine:moss', `moss-voice:${ttsMossVoice}`]
              : [
                  'ai-generated',
                  'custom-ai-tts',
                  'tts-engine:custom',
                  `custom-tts-model:${customTtsConfig.model}`,
                  `custom-tts-voice:${customVoiceLabel}`,
                ]

      const generation: AudioGeneration = {
        id: crypto.randomUUID(),
        file,
        objectUrl,
        byteSize: blob.size,
        duration,
        textSnippet: trimmedTtsText,
        voice: voiceLabel,
        model: modelLabel,
        summary: trimmedTtsText,
        details: `${voiceLabel} / ${modelLabel} / ${duration > 0 ? `${duration.toFixed(1)}s` : '-'} / ${formatBytes(blob.size)}`,
        tags: engineTags,
        savedMediaId: null,
        saving: false,
      }

      setTtsGenerations((prev) => [generation, ...prev])
      setTtsProgress(null)
    } catch (generationError) {
      setTtsError(
        generationError instanceof Error
          ? generationError.message
          : t('editor.tts.errors.generateFailed'),
      )
      setTtsProgress(null)
    } finally {
      setIsTtsGenerating(false)
    }
  }, [
    currentProjectId,
    customTtsConfig.model,
    customTtsConfig.voice,
    effectiveTtsSpeed,
    isTtsSupported,
    trimmedTtsText,
    ttsEngine,
    ttsKokoroVoice,
    ttsModel,
    ttsMossVoice,
    ttsSupertonicVoice,
    ttsSupertonicLanguage,
    ttsSupertonicQuality,
    t,
  ])

  const handleMusicGenerate = useCallback(async () => {
    if (!currentProjectId) return null
    if (!trimmedMusicPrompt) {
      setMusicError(t('editor.aiPanel.errors.describeMusic'))
      return null
    }
    if (!isMusicSupported) {
      setMusicError(t('editor.aiPanel.errors.musicgenUnsupported'))
      return null
    }

    const abortController = new AbortController()
    musicAbortRef.current = abortController

    setMusicError(null)
    setIsMusicGenerating(true)
    setMusicProgress(t('editor.aiPanel.progressPreparingMusic'))
    setMusicProgressPct(null)

    try {
      const { blob, file, duration } = await musicgenService.generateMusicFile({
        prompt: trimmedMusicPrompt,
        model: musicModel,
        durationSeconds: musicDuration,
        onProgress: (stage, fraction) => {
          setMusicProgress(stage)
          setMusicProgressPct(fraction ?? null)
        },
        signal: abortController.signal,
      })

      const objectUrl = URL.createObjectURL(blob)
      generationUrlsRef.current.add(objectUrl)

      const modelLabel =
        MUSICGEN_MODEL_OPTIONS.find((option) => option.value === musicModel)?.label ?? musicModel
      const generation: AudioGeneration = {
        id: crypto.randomUUID(),
        file,
        objectUrl,
        byteSize: blob.size,
        duration,
        textSnippet: trimmedMusicPrompt,
        voice: modelLabel,
        model: `target ${musicDuration}s`,
        summary: trimmedMusicPrompt,
        details: `${modelLabel} / target ${musicDuration}s / ${duration > 0 ? `${duration.toFixed(1)}s` : '-'} / ${formatBytes(blob.size)}`,
        tags: [
          'ai-generated',
          'musicgen',
          `musicgen-model:${musicModel}`,
          `musicgen-target:${musicDuration}s`,
        ],
        savedMediaId: null,
        saving: false,
      }

      setMusicGenerations((prev) => [generation, ...prev])
    } catch (generationError) {
      if (generationError instanceof DOMException && generationError.name === 'AbortError') {
        // Intentional cancellation — no error shown.
      } else {
        setMusicError(
          generationError instanceof Error
            ? generationError.message
            : t('editor.aiPanel.errors.generateMusicFailed'),
        )
      }
    } finally {
      musicAbortRef.current = null
      setIsMusicGenerating(false)
      setMusicProgress(null)
      setMusicProgressPct(null)
    }
  }, [currentProjectId, trimmedMusicPrompt, isMusicSupported, musicModel, musicDuration, t])

  const handleMusicCancel = useCallback(() => {
    musicAbortRef.current?.abort()
  }, [])

  // Push a freshly-generated image (from AiImagePanel) onto the multi-shot
  // history. The panel owns generation + abort lifecycle; we only persist
  // the metadata + own a copy of the object URL so the row's lightbox keeps
  // working after the panel re-renders.
  const handleImageGenerated = useCallback(
    (payload: AiImageGeneratedPayload) => {
      const dims = resolveImageDimensions(
        payload.form.aspect,
        projectCanvasWidth,
        projectCanvasHeight,
      )
      const objectUrl = URL.createObjectURL(payload.blob)
      generationUrlsRef.current.add(objectUrl)
      const mime = payload.blob.type || 'image/png'
      const subtype = mime.split('/')[1]?.split(';')[0] ?? 'png'
      const extension = subtype === 'jpeg' ? 'jpg' : subtype
      const fileName = `ai-image-${Date.now()}.${extension}`
      const file = new File([payload.blob], fileName, { type: mime })
      const aspectLabelForRow =
        payload.form.aspect === 'auto'
          ? `canvas (${projectCanvasWidth}×${projectCanvasHeight})`
          : payload.aspectLabel

      const generation: ImageGeneration = {
        id: crypto.randomUUID(),
        file,
        blob: payload.blob,
        objectUrl,
        byteSize: payload.blob.size,
        width: payload.width || dims.width,
        height: payload.height || dims.height,
        promptSnippet: payload.form.prompt || payload.resolvedPrompt,
        details: `${aspectLabelForRow} / ${payload.width || dims.width}×${payload.height || dims.height} / ${formatBytes(payload.blob.size)}`,
        tags: [
          'ai-generated',
          'image-generator',
          'image-generator:freeform',
          `image-generator-model:${imageGeneratorConfig.model}`,
          ...(payload.form.cast !== 'auto' ? [`image-generator-cast:${payload.form.cast}`] : []),
          ...(payload.form.style !== 'auto' ? [`image-generator-style:${payload.form.style}`] : []),
        ],
        savedMediaId: null,
        saving: false,
      }
      setImageGenerations((prev) => [generation, ...prev])
    },
    [imageGeneratorConfig.model, projectCanvasHeight, projectCanvasWidth],
  )

  const saveImageGeneration = useCallback(
    async (generation: ImageGeneration): Promise<MediaMetadata | null> => {
      if (!currentProjectId) return null
      setImageGenerations((prev) =>
        prev.map((g) => (g.id === generation.id ? { ...g, saving: true } : g)),
      )
      try {
        const { mediaLibraryService } = await importMediaLibraryService()
        const subtype =
          (generation.file.type || generation.blob.type || 'image/png')
            .split('/')[1]
            ?.split(';')[0]
            ?.trim() ?? 'png'
        const media = await mediaLibraryService.importGeneratedImage(
          generation.file,
          currentProjectId,
          {
            width: generation.width,
            height: generation.height,
            tags: generation.tags,
            codec: subtype,
          },
        )
        await loadMediaItems()
        selectMedia([media.id])
        generationUrlsRef.current.delete(generation.objectUrl)
        setImageGenerations((prev) =>
          prev.map((g) =>
            g.id === generation.id ? { ...g, saving: false, savedMediaId: media.id } : g,
          ),
        )
        return media
      } catch (saveError) {
        setImageSaveError(
          saveError instanceof Error
            ? saveError.message
            : 'Failed to save image to the media library.',
        )
        setImageGenerations((prev) =>
          prev.map((g) => (g.id === generation.id ? { ...g, saving: false } : g)),
        )
        return null
      }
    },
    [currentProjectId, loadMediaItems, selectMedia],
  )

  const handleSaveImage = useCallback(
    async (generation: ImageGeneration) => {
      const media = await saveImageGeneration(generation)
      if (media) {
        showNotification({
          type: 'success',
          message: `Saved "${media.fileName}" to the media library.`,
        })
      }
    },
    [saveImageGeneration, showNotification],
  )

  const handleRemoveImageGeneration = useCallback((id: string) => {
    setImageGenerations((prev) => {
      const generation = prev.find((entry) => entry.id === id)
      if (generation && !generation.savedMediaId) {
        URL.revokeObjectURL(generation.objectUrl)
        generationUrlsRef.current.delete(generation.objectUrl)
      }
      return prev.filter((entry) => entry.id !== id)
    })
  }, [])

  const handleClearImageGenerations = useCallback(() => {
    setImageGenerations((prev) => {
      for (const generation of prev) {
        if (!generation.savedMediaId) {
          URL.revokeObjectURL(generation.objectUrl)
          generationUrlsRef.current.delete(generation.objectUrl)
        }
      }
      return []
    })
  }, [])

  const totalImageBytes = useMemo(
    () => imageGenerations.reduce((sum, g) => sum + g.byteSize, 0),
    [imageGenerations],
  )
  const anyImageSaving = imageGenerations.some((g) => g.saving)

  const updateGenerationInList = useCallback(
    (
      setGenerations: Dispatch<SetStateAction<AudioGeneration[]>>,
      id: string,
      patch: Partial<AudioGeneration>,
    ) => {
      setGenerations((prev) =>
        prev.map((generation) => (generation.id === id ? { ...generation, ...patch } : generation)),
      )
    },
    [],
  )

  const saveGeneration = useCallback(
    async (
      generation: AudioGeneration,
      setGenerations: Dispatch<SetStateAction<AudioGeneration[]>>,
      setError: Dispatch<SetStateAction<string | null>>,
    ): Promise<MediaMetadata | null> => {
      if (!currentProjectId) return null
      updateGenerationInList(setGenerations, generation.id, { saving: true })

      try {
        const { mediaLibraryService } = await importMediaLibraryService()
        const media = await mediaLibraryService.importGeneratedAudio(
          generation.file,
          currentProjectId,
          {
            tags: generation.tags,
          },
        )

        await loadMediaItems()
        selectMedia([media.id])
        // Remove from tracked URLs so unmount cleanup won't revoke a URL
        // that may be referenced by a timeline item's src
        generationUrlsRef.current.delete(generation.objectUrl)
        updateGenerationInList(setGenerations, generation.id, {
          saving: false,
          savedMediaId: media.id,
        })
        return media
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : t('editor.aiPanel.errors.saveAudioFailed'),
        )
        updateGenerationInList(setGenerations, generation.id, { saving: false })
        return null
      }
    },
    [currentProjectId, loadMediaItems, selectMedia, t, updateGenerationInList],
  )

  const handleSave = useCallback(
    async (
      generation: AudioGeneration,
      setGenerations: Dispatch<SetStateAction<AudioGeneration[]>>,
      setError: Dispatch<SetStateAction<string | null>>,
    ) => {
      const media = await saveGeneration(generation, setGenerations, setError)
      if (media) {
        showNotification({
          type: 'success',
          message: t('editor.aiPanel.notifications.savedToLibrary', {
            fileName: media.fileName,
          }),
        })
      }
    },
    [saveGeneration, showNotification, t],
  )

  const handleSaveAndInsert = useCallback(
    async (
      generation: AudioGeneration,
      setGenerations: Dispatch<SetStateAction<AudioGeneration[]>>,
      setError: Dispatch<SetStateAction<string | null>>,
    ) => {
      const media = await saveGeneration(generation, setGenerations, setError)
      if (!media) return

      const inserted = insertAudioItemAtPlayhead(media, generation.objectUrl)
      showNotification({
        type: inserted ? 'success' : 'warning',
        message: inserted
          ? t('editor.aiPanel.notifications.savedAndAdded', { fileName: media.fileName })
          : t('editor.tts.notifications.savedNoTrack', { fileName: media.fileName }),
      })
    },
    [saveGeneration, showNotification, t],
  )

  const removeGenerationFromList = useCallback(
    (setGenerations: Dispatch<SetStateAction<AudioGeneration[]>>, id: string) => {
      setGenerations((prev) => {
        const generation = prev.find((entry) => entry.id === id)
        if (generation) {
          // Only revoke the blob URL if it has not been saved; saved items may
          // have their blob URL referenced by a timeline audio item's `src`.
          if (!generation.savedMediaId) {
            URL.revokeObjectURL(generation.objectUrl)
            generationUrlsRef.current.delete(generation.objectUrl)
          }
        }
        return prev.filter((entry) => entry.id !== id)
      })
    },
    [],
  )

  const clearGenerationList = useCallback(
    (setGenerations: Dispatch<SetStateAction<AudioGeneration[]>>) => {
      // Only revoke blob URLs for unsaved generations; saved ones may be
      // referenced by timeline items.
      setGenerations((prev) => {
        for (const generation of prev) {
          if (!generation.savedMediaId) {
            URL.revokeObjectURL(generation.objectUrl)
            generationUrlsRef.current.delete(generation.objectUrl)
          }
        }
        return []
      })
    },
    [],
  )

  const handleSaveTtsGeneration = useCallback(
    (generation: AudioGeneration) => handleSave(generation, setTtsGenerations, setTtsError),
    [handleSave],
  )
  const handleSaveAndInsertTtsGeneration = useCallback(
    (generation: AudioGeneration) =>
      handleSaveAndInsert(generation, setTtsGenerations, setTtsError),
    [handleSaveAndInsert],
  )
  const handleGenerate = handleTtsGenerate
  const handleClearAll = () => clearGenerationList(setTtsGenerations)
  const handleRemoveGeneration = (id: string) => removeGenerationFromList(setTtsGenerations, id)

  return (
    <div className="p-3">
      <div className="space-y-3">
        <Collapsible open={ttsSectionOpen} onOpenChange={setTtsSectionOpen}>
          <div className="-mx-3 -mt-3 bg-secondary/50 px-3 py-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                aria-label={
                  ttsSectionOpen
                    ? t('editor.aiPanel.collapseTextToSpeech')
                    : t('editor.aiPanel.expandTextToSpeech')
                }
              >
                <h2 className="text-sm font-medium">{t('editor.aiPanel.textToSpeech')}</h2>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 text-muted-foreground transition-transform',
                    ttsSectionOpen && 'rotate-180',
                  )}
                />
              </button>
            </CollapsibleTrigger>
          </div>

          <CollapsibleContent className="space-y-4 pt-3">
            {!isTtsSupported && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                {ttsEngine === 'kokoro'
                  ? t('editor.tts.kokoroUnsupported')
                  : ttsEngine === 'supertonic'
                    ? t('editor.tts.supertonicUnsupported', {
                        defaultValue:
                          'Supertonic 3 needs a browser with Web Worker + Cache Storage. Try a recent Chromium browser, Firefox, or Safari.',
                      })
                    : ttsEngine === 'moss'
                      ? t('editor.tts.mossUnsupported')
                      : 'Configure Base URL, API key, and model in Settings → AI → Custom AI → Text to Speech.'}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="ai-tts-text">{t('editor.tts.text')}</Label>
              <Textarea
                ref={ttsTextareaRef}
                id="ai-tts-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t('editor.tts.textPlaceholder')}
                className="min-h-24 resize-y bg-secondary/30 text-sm"
                disabled={isGenerating}
              />
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>{t('editor.tts.engine')}</Label>
                <Select
                  value={ttsEngine}
                  onValueChange={(value) => setTtsEngine(value as StoredTtsEngine)}
                  disabled={isGenerating}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kokoro" className="text-xs">
                      {t('editor.tts.kokoroOption')}
                    </SelectItem>
                    <SelectItem value="supertonic" className="text-xs">
                      {t('editor.tts.supertonicOption', {
                        defaultValue: 'Supertonic 3 (31 languages, WebGPU/WASM)',
                      })}
                    </SelectItem>
                    <SelectItem value="moss" className="text-xs">
                      {t('editor.tts.mossOption')}
                    </SelectItem>
                    <SelectItem value="custom" className="text-xs">
                      Custom AI (OpenAI-compatible)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {!isCustomTtsEngine && (
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t('editor.tts.voice')}</Label>
                    <Select
                      value={voice}
                      onValueChange={(value) => {
                        if (ttsEngine === 'kokoro') {
                          setTtsKokoroVoice(value as KokoroTtsVoice)
                        } else if (ttsEngine === 'supertonic') {
                          setTtsSupertonicVoice(value as SupertonicTtsVoice)
                        } else {
                          setTtsMossVoice(value as MossTtsVoice)
                        }
                      }}
                      disabled={isGenerating}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {(ttsEngine === 'kokoro'
                          ? KOKORO_TTS_VOICE_OPTIONS
                          : ttsEngine === 'supertonic'
                            ? SUPERTONIC_TTS_VOICE_OPTIONS
                            : MOSS_TTS_VOICE_OPTIONS
                        ).map((option) => (
                          <SelectItem key={option.value} value={option.value} className="text-xs">
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {ttsEngine === 'supertonic' && (
                    <div className="space-y-1.5">
                      <Label>{t('editor.tts.language', { defaultValue: 'Language' })}</Label>
                      <Select
                        value={ttsSupertonicLanguage}
                        onValueChange={(value) =>
                          setTtsSupertonicLanguage(value as SupertonicTtsLanguage)
                        }
                        disabled={isGenerating}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          {SUPERTONIC_TTS_LANGUAGES.map((option) => (
                            <SelectItem key={option.value} value={option.value} className="text-xs">
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}

              {isCustomTtsEngine && isCustomTtsConfigured && (
                <CustomTtsConfigSummary
                  model={customTtsConfig.model}
                  voiceValue={customTtsConfig.voice}
                />
              )}
            </div>

            <div className="flex items-center gap-2">
              {supportsNativeTtsSpeed && (
                <SliderInput
                  label={t('editor.tts.speed')}
                  value={speed}
                  onChange={setSpeed}
                  min={ttsSpeedMin}
                  max={ttsSpeedMax}
                  step={0.05}
                  unit="x"
                  disabled={isGenerating}
                />
              )}
              <Button
                size="sm"
                onClick={() => {
                  void handleGenerate()
                }}
                disabled={isGenerating || !trimmedText || !currentProjectId || !isTtsSupported}
                className="h-7 shrink-0 gap-1.5"
              >
                {isGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <WandSparkles className="h-3.5 w-3.5" />
                )}
                {isGenerating ? t('editor.tts.generating') : t('editor.tts.generate')}
              </Button>
            </div>

            {ttsEngine === 'supertonic' && (
              <SliderInput
                label="Quality"
                value={ttsSupertonicQuality}
                onChange={(value) => setTtsSupertonicQuality(Math.round(value))}
                min={SUPERTONIC_TTS_QUALITY_MIN}
                max={SUPERTONIC_TTS_QUALITY_MAX}
                step={1}
                unit=" steps"
                disabled={isGenerating}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              {isCustomTtsEngine
                ? `${currentTtsRuntimeLabel} sends each request to your configured ${currentTtsBackendLabel} endpoint.`
                : t('editor.aiPanel.runsLocally', {
                    runtime: currentTtsRuntimeLabel,
                    backend: currentTtsBackendLabel,
                  })}
            </p>

            {progress && (
              <div className="rounded-lg border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                {progress}
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {error}
              </div>
            )}

            {generations.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('editor.aiPanel.history', {
                      count: generations.length,
                      size: formatBytes(totalBytes),
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
                    onClick={handleClearAll}
                    disabled={anySaving}
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('editor.aiPanel.clearAll')}
                  </Button>
                </div>

                <div className="space-y-2">
                  {generations.map((gen) => (
                    <GenerationRow
                      key={gen.id}
                      generation={gen}
                      onSave={handleSaveTtsGeneration}
                      onSaveAndInsert={handleSaveAndInsertTtsGeneration}
                      onRemove={handleRemoveGeneration}
                    />
                  ))}
                </div>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        <Collapsible open={musicSectionOpen} onOpenChange={setMusicSectionOpen}>
          <div className="-mx-3 bg-secondary/50 px-3 py-2">
            <div className="flex items-center gap-2">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex flex-1 items-center justify-between gap-2 text-left"
                  aria-label={
                    musicSectionOpen
                      ? t('editor.aiPanel.collapseMusicGeneration')
                      : t('editor.aiPanel.expandMusicGeneration')
                  }
                >
                  <h2 className="text-sm font-medium">{t('editor.aiPanel.musicGeneration')}</h2>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-muted-foreground transition-transform',
                      musicSectionOpen && 'rotate-180',
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <Popover open={musicInfoOpen} onOpenChange={setMusicInfoOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={t('editor.aiPanel.musicGenerationInfo')}
                    onMouseEnter={() => setMusicInfoOpen(true)}
                    onMouseLeave={() => setMusicInfoOpen(false)}
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  className="w-72 space-y-2 p-3 text-xs"
                  onMouseEnter={() => setMusicInfoOpen(true)}
                  onMouseLeave={() => setMusicInfoOpen(false)}
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      WebGPU
                    </span>
                    <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Local
                    </span>
                  </div>
                  <p className="leading-relaxed text-muted-foreground">
                    {t('editor.aiPanel.musicgenDescription')}
                  </p>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {MUSICGEN_MODEL_OPTIONS.map((option) => (
                        <tr key={option.value} className="border-t border-border/50">
                          <td className="py-1 pr-2 font-medium text-foreground">{option.label}</td>
                          <td className="py-1 text-right text-muted-foreground">
                            {option.downloadLabel}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="leading-relaxed text-muted-foreground">
                    {t('editor.aiPanel.musicgenPromptHint')}
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <CollapsibleContent className="space-y-4 pt-3">
            {!isMusicSupported && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                {t('editor.aiPanel.musicgenUnsupported')}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="ai-music-prompt">{t('editor.aiPanel.prompt')}</Label>
                <Select
                  value=""
                  onValueChange={(value) => setMusicPrompt(value)}
                  disabled={isMusicGenerating}
                >
                  <SelectTrigger className="h-6 w-auto gap-1 border-none bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none hover:text-foreground">
                    <SelectValue placeholder={t('editor.aiPanel.presets')} />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {MUSIC_PROMPT_PRESETS.map((preset) => (
                      <SelectItem
                        key={preset.labelKey}
                        value={t(preset.promptKey)}
                        className="text-xs"
                      >
                        {t(preset.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                id="ai-music-prompt"
                value={musicPrompt}
                onChange={(event) => setMusicPrompt(event.target.value)}
                placeholder={t('editor.aiPanel.musicPromptPlaceholder')}
                className="min-h-24 resize-y bg-secondary/30 text-sm"
                disabled={isMusicGenerating}
              />
            </div>

            <SliderInput
              label={t('editor.aiPanel.length')}
              value={musicDuration}
              onChange={(value) => setMusicDuration(Math.round(value))}
              min={currentMusicModel.minDurationSeconds}
              max={currentMusicModel.maxDurationSeconds}
              step={1}
              unit="s"
              disabled={isMusicGenerating}
            />

            <div className="flex items-center justify-end gap-2">
              {isMusicGenerating && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleMusicCancel}
                  className="h-7 shrink-0 gap-1.5 text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                  {t('common.cancel')}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => {
                  void handleMusicGenerate()
                }}
                disabled={
                  isMusicGenerating || !trimmedMusicPrompt || !currentProjectId || !isMusicSupported
                }
                className="h-7 shrink-0 gap-1.5"
              >
                {isMusicGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <WandSparkles className="h-3.5 w-3.5" />
                )}
                {isMusicGenerating ? t('editor.tts.generating') : t('editor.aiPanel.generateMusic')}
              </Button>
            </div>

            {musicProgress && (
              <div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-3">
                <p className="text-xs text-muted-foreground">{musicProgress}</p>
                {musicProgressPct != null && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-300 ease-linear"
                      style={{ width: `${Math.round(musicProgressPct * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {musicError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {musicError}
              </div>
            )}

            {musicGenerations.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('editor.aiPanel.musicHistory', {
                      count: musicGenerations.length,
                      size: formatBytes(totalMusicBytes),
                    })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
                    onClick={() => clearGenerationList(setMusicGenerations)}
                    disabled={anyMusicSaving}
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('editor.aiPanel.clearAll')}
                  </Button>
                </div>

                <div className="space-y-2">
                  {musicGenerations.map((generation) => (
                    <GenerationRow
                      key={generation.id}
                      generation={generation}
                      onSave={(entry) => handleSave(entry, setMusicGenerations, setMusicError)}
                      onSaveAndInsert={(entry) =>
                        handleSaveAndInsert(entry, setMusicGenerations, setMusicError)
                      }
                      onRemove={(id) => removeGenerationFromList(setMusicGenerations, id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        <Collapsible open={imageSectionOpen} onOpenChange={setImageSectionOpen}>
          <div className="-mx-3 bg-secondary/50 px-3 py-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                aria-label={
                  imageSectionOpen
                    ? t('editor.aiPanel.collapseImageGeneration')
                    : t('editor.aiPanel.expandImageGeneration')
                }
              >
                <h2 className="text-sm font-medium">{t('editor.aiPanel.imageGeneration')}</h2>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 text-muted-foreground transition-transform',
                    imageSectionOpen && 'rotate-180',
                  )}
                />
              </button>
            </CollapsibleTrigger>
          </div>

          <CollapsibleContent className="space-y-4 pt-3">
            <AiImagePanel
              width={projectCanvasWidth}
              height={projectCanvasHeight}
              promptMode="single"
              variant="sidebar"
              imageGeneratorConfigured={isCustomImageGeneratorConfigured}
              imageGeneratorModel={imageGeneratorConfig.model}
              imageGeneratorBaseUrl={imageGeneratorConfig.baseUrl}
              initialValues={{ prompt: DEFAULT_IMAGE_PROMPT, aspect: defaultImageAspect }}
              hideCurrentPreview
              generateLabel="Generate Image"
              disabled={!currentProjectId}
              onImageGenerated={handleImageGenerated}
            />

            {imageSaveError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {imageSaveError}
              </div>
            )}

            {imageGenerations.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Image History ({imageGenerations.length}) - {formatBytes(totalImageBytes)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
                    onClick={handleClearImageGenerations}
                    disabled={anyImageSaving}
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('editor.aiPanel.clearAll')}
                  </Button>
                </div>

                <div className="space-y-2">
                  {imageGenerations.map((generation) => (
                    <ImageGenerationRow
                      key={generation.id}
                      generation={generation}
                      onSave={handleSaveImage}
                      onRemove={handleRemoveImageGeneration}
                    />
                  ))}
                </div>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
})

function CustomTtsConfigSummary({ model, voiceValue }: { model: string; voiceValue: string }) {
  const voiceLabel = voiceValue.trim() || 'alloy (default)'
  return (
    <div className="rounded-md border border-border/60 bg-secondary/30 px-2.5 py-2 text-[11px] text-muted-foreground">
      Model <span className="text-foreground">{model}</span> · Voice{' '}
      <span className="text-foreground">{voiceLabel}</span>
    </div>
  )
}

// --- Row component ---

const GenerationRow = memo(function GenerationRow({
  generation: gen,
  onSave,
  onSaveAndInsert,
  onRemove,
}: {
  generation: Generation
  onSave: (gen: Generation) => Promise<void>
  onSaveAndInsert: (gen: Generation) => Promise<void>
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation()
  const saved = gen.savedMediaId !== null

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 ${
        saved ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-border bg-secondary/20'
      }`}
    >
      {/* Meta row */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="line-clamp-3 text-xs leading-relaxed" title={gen.textSnippet}>
            {gen.textSnippet}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {gen.voice} / {gen.model} / {gen.duration > 0 ? `${gen.duration.toFixed(1)}s` : '-'} /{' '}
            {formatBytes(gen.byteSize)}
          </p>
        </div>
        {!gen.saving && (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => onRemove(gen.id)}
            aria-label={t('editor.aiPanel.remove')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Audio player */}
      <MiniAudioPlayer src={gen.objectUrl} />

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        {saved ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {t('editor.aiPanel.saved')}
          </span>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => {
                void onSaveAndInsert(gen)
              }}
              disabled={gen.saving}
            >
              {gen.saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ListPlus className="h-3 w-3" />
              )}
              {gen.saving ? t('editor.aiPanel.saving') : t('editor.aiPanel.saveAndInsert')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => {
                void onSave(gen)
              }}
              disabled={gen.saving}
            >
              <Download className="h-3 w-3" />
              {t('editor.aiPanel.saveToLibrary')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
})

const ImageGenerationRow = memo(function ImageGenerationRow({
  generation,
  onSave,
  onRemove,
}: {
  generation: ImageGeneration
  onSave: (gen: ImageGeneration) => Promise<void>
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation()
  const saved = generation.savedMediaId !== null

  const handleSetCoverToCompounds = useCallback(() => {
    if (generation.savedMediaId) {
      useSetCoverToCompoundsDialogStore.getState().open({
        kind: 'media-library',
        mediaId: generation.savedMediaId,
        src: generation.objectUrl,
        width: generation.width,
        height: generation.height,
      })
      return
    }
    useSetCoverToCompoundsDialogStore.getState().open({
      kind: 'unsaved-blob',
      file: generation.file,
      objectUrl: generation.objectUrl,
      width: generation.width,
      height: generation.height,
      tags: ['ai-generated', 'compound-cover:bulk', ...generation.tags],
      promptSnippet: generation.promptSnippet,
    })
  }, [generation])

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border p-3',
        saved ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-border bg-secondary/20',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="line-clamp-3 text-xs leading-relaxed" title={generation.promptSnippet}>
            {generation.promptSnippet}
          </p>
          <p className="text-[11px] text-muted-foreground">{generation.details}</p>
        </div>
        {!generation.saving && (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => onRemove(generation.id)}
            aria-label="Remove"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <ImageLightbox
              src={generation.objectUrl}
              alt={generation.promptSnippet}
              downloadFilename={generation.file.name}
            >
              <button
                type="button"
                className="flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md border border-border bg-black"
                aria-label={t('editor.aiPanel.openImagePreview')}
              >
                <img
                  src={generation.objectUrl}
                  alt={t('editor.aiPanel.generatedImage')}
                  className="block max-h-[240px] max-w-full"
                  style={{
                    aspectRatio:
                      generation.width > 0 && generation.height > 0
                        ? `${generation.width} / ${generation.height}`
                        : undefined,
                  }}
                />
              </button>
            </ImageLightbox>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={handleSetCoverToCompounds}>
            <Layers className="w-3 h-3 mr-2" />
            Set cover to compound…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div className="flex flex-wrap items-center gap-1.5">
        {saved ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {t('editor.aiPanel.savedToMediaLibrary')}
          </span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => {
              void onSave(generation)
            }}
            disabled={generation.saving}
          >
            {generation.saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {generation.saving ? 'Saving...' : 'Save to Library'}
          </Button>
        )}
      </div>
    </div>
  )
})
