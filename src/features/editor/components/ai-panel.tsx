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
import {
  CheckCircle2,
  ChevronDown,
  Download,
  Image as ImageIcon,
  Info,
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
import { Input } from '@/components/ui/input'
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
  buildFreeformImagePrompt,
  generateCoverImage,
  POSTER_CAST_OPTIONS,
  POSTER_MOOD_OPTIONS,
  POSTER_QUALITY_OPTIONS,
  POSTER_STYLE_OPTIONS,
  resolvePosterQualityApiValue,
  type PosterCastValue,
  type PosterMoodValue,
  type PosterQualityValue,
  type PosterStyleValue,
} from '@/features/editor/deps/compound-cover'
import { useProjectStore } from '@/features/editor/deps/projects'
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
  DEFAULT_MUSICGEN_MODEL,
  MUSICGEN_MODEL_OPTIONS,
  musicgenService,
  type MusicgenModelId,
} from '../services/musicgen-service'
import { customTtsService } from '../services/custom-tts-service'

const DEFAULT_PROMPT = 'Welcome to freecut. This voice was generated locally in the browser.'

const MUSIC_PROMPT_PRESETS = [
  {
    label: 'Lo-fi Chill',
    prompt: 'Warm lo-fi beat with dusty drums, mellow bass, and a dreamy synth lead',
  },
  { label: '80s Pop', prompt: '80s pop track with bassy drums and synth' },
  { label: '90s Rock', prompt: '90s rock song with loud guitars and heavy drums' },
  {
    label: 'Upbeat EDM',
    prompt:
      'A light and cheery EDM track, with syncopated drums, airy pads, and strong emotions bpm: 130',
  },
  { label: 'Country', prompt: 'A cheerful country song with acoustic guitars' },
  { label: 'Lo-fi Electro', prompt: 'Lofi slow bpm electro chill with organic samples' },
]

const DEFAULT_MUSIC_PROMPT = MUSIC_PROMPT_PRESETS[0]!.prompt

const DEFAULT_IMAGE_PROMPT =
  'A cinematic photograph of a lone figure walking down a rain-soaked alleyway at night, neon signs reflecting in the puddles.'

interface AspectRatioOption {
  value: string
  label: string
  /** width:height pair used to draw the icon. `null` = "None / Default". */
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

/**
 * Resolve API call dimensions from the user's chosen aspect ratio. Falls back
 * to the project canvas when the user picks "None (Default)". The image
 * adapter's `resolveSize` snaps these to one of OpenAI's three supported
 * sizes, so we only need to convey the ratio correctly.
 */
function resolveImageDimensions(
  aspect: string,
  projectWidth: number,
  projectHeight: number,
): { width: number; height: number } {
  const opt = ASPECT_RATIO_OPTIONS.find((o) => o.value === aspect)
  if (!opt || !opt.dim) {
    return {
      width: projectWidth > 0 ? projectWidth : 1024,
      height: projectHeight > 0 ? projectHeight : 1024,
    }
  }
  const ratio = opt.dim.w / opt.dim.h
  const baseSize = Math.max(projectWidth, projectHeight, 1024)
  return ratio >= 1
    ? { width: baseSize, height: Math.round(baseSize / ratio) }
    : { width: Math.round(baseSize * ratio), height: baseSize }
}

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
        aria-label={isPlaying ? 'Pause' : 'Play'}
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
        aria-label="Seek"
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
  const currentProjectId = useMediaLibraryStore((state) => state.currentProjectId)
  const loadMediaItems = useMediaLibraryStore((state) => state.loadMediaItems)
  const selectMedia = useMediaLibraryStore((state) => state.selectMedia)
  const showNotification = useMediaLibraryStore((state) => state.showNotification)

  const customTtsConfig = useCustomAiStore((s) => s.textToSpeech)
  const isCustomTtsConfigured = isTextToSpeechConfigured(customTtsConfig)
  const imageGeneratorConfig = useCustomAiStore((s) => s.imageGenerator)
  const isCustomImageGeneratorConfigured = isImageGeneratorConfigured(imageGeneratorConfig)

  const [ttsText, setTtsText] = useState(DEFAULT_PROMPT)
  const [ttsEngine, setTtsEngine] = useState<StoredTtsEngine>(() =>
    // First-run users with Custom TTS configured default to 'custom'; users
    // who explicitly chose kokoro/moss before keep their stored preference.
    getStoredTtsEngine(isCustomTtsConfigured ? 'custom' : 'kokoro'),
  )
  const [ttsKokoroVoice, setTtsKokoroVoice] = useState<KokoroTtsVoice>('af_heart')
  const [ttsMossVoice, setTtsMossVoice] = useState<MossTtsVoice>('Xiaoyu')
  const ttsModel: KokoroTtsModel = KOKORO_TTS_BEST_MODEL
  const [ttsSpeed, setTtsSpeed] = useState(1)
  const [isTtsGenerating, setIsTtsGenerating] = useState(false)
  const [ttsProgress, setTtsProgress] = useState<string | null>(null)
  const [ttsError, setTtsError] = useState<string | null>(null)
  const [ttsGenerations, setTtsGenerations] = useState<AudioGeneration[]>([])
  const [ttsSectionOpen, setTtsSectionOpen] = useState(true)

  const [musicPrompt, setMusicPrompt] = useState(DEFAULT_MUSIC_PROMPT)
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
  const projectMetadata = useProjectStore((s) => s.currentProject?.metadata)
  const projectCanvasWidth = projectMetadata?.width ?? 1024
  const projectCanvasHeight = projectMetadata?.height ?? 1024
  const defaultImageAspect = useMemo(
    () => pickAspectRatioFromCanvas(projectCanvasWidth, projectCanvasHeight),
    [projectCanvasWidth, projectCanvasHeight],
  )
  const [imagePrompt, setImagePrompt] = useState(DEFAULT_IMAGE_PROMPT)
  const [imageAspect, setImageAspect] = useState<string>(defaultImageAspect)
  const [imageCast, setImageCast] = useState<PosterCastValue>('auto')
  const [imageStyle, setImageStyle] = useState<PosterStyleValue>('photoreal')
  const [imageMood, setImageMood] = useState<PosterMoodValue>('auto')
  const [imageQuality, setImageQuality] = useState<PosterQualityValue>('auto')
  const [imageCustomNotes, setImageCustomNotes] = useState('')
  const [isImageGenerating, setIsImageGenerating] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageGenerations, setImageGenerations] = useState<ImageGeneration[]>([])
  const [imageSectionOpen, setImageSectionOpen] = useState(true)
  const imageAbortRef = useRef<AbortController | null>(null)
  // Keep the aspect dropdown in sync if the project canvas changes while the
  // panel is mounted (rare — only when the user resizes the canvas — but
  // keeps the default sensible when they do).
  useEffect(() => {
    setImageAspect((prev) => (prev === '' ? defaultImageAspect : prev))
  }, [defaultImageAspect])

  const musicAbortRef = useRef<AbortController | null>(null)
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
      imageAbortRef.current?.abort()
      imageAbortRef.current = null
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
  const isCustomTtsEngine = ttsEngine === 'custom'
  const supportsNativeTtsSpeed = ttsEngine === 'kokoro' || isCustomTtsEngine
  const effectiveTtsSpeed = supportsNativeTtsSpeed ? ttsSpeed : 1
  const isTtsSupported =
    ttsEngine === 'kokoro'
      ? isKokoroSupported
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
  const voice = ttsEngine === 'kokoro' ? ttsKokoroVoice : ttsEngine === 'moss' ? ttsMossVoice : ''
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
    ttsEngine === 'kokoro' ? 'WebGPU' : ttsEngine === 'moss' ? 'CPU' : 'Network'
  const currentTtsRuntimeLabel =
    ttsEngine === 'kokoro' ? 'Kokoro TTS Best' : ttsEngine === 'moss' ? 'MOSS Nano' : 'Custom AI'

  // --- actions ---

  const handleTtsGenerate = useCallback(async () => {
    if (!currentProjectId) {
      setTtsError('Open a project before generating audio.')
      return
    }
    if (!trimmedTtsText) {
      setTtsError('Enter some text to synthesize.')
      return
    }
    if (!isTtsSupported) {
      setTtsError(
        ttsEngine === 'kokoro'
          ? 'WebGPU is required for Kokoro TTS. Try Chrome 113+, Edge 113+, or Safari 26+.'
          : ttsEngine === 'moss'
            ? 'Browser-managed storage is required for MOSS multilingual TTS. Try a recent Chromium browser.'
            : 'Custom AI TTS is not configured. Open Settings → AI → Custom AI → Text to Speech.',
      )
      return
    }

    setTtsError(null)
    setIsTtsGenerating(true)
    setTtsProgress(ttsEngine === 'custom' ? 'Calling Custom AI TTS...' : 'Preparing local TTS...')

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
          : ttsEngine === 'moss'
            ? getMossTtsVoiceOption(ttsMossVoice).label
            : customVoiceLabel
      const modelLabel =
        ttsEngine === 'kokoro'
          ? getKokoroTtsModelOption(ttsModel).label
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
        generationError instanceof Error ? generationError.message : 'Failed to generate speech.',
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
  ])

  const handleMusicGenerate = useCallback(async () => {
    if (!currentProjectId) return null
    if (!trimmedMusicPrompt) {
      setMusicError('Describe the music you want to generate.')
      return null
    }
    if (!isMusicSupported) {
      setMusicError('WebGPU is required for MusicGen. Try Chrome 113+, Edge 113+, or Safari 26+.')
      return null
    }

    const abortController = new AbortController()
    musicAbortRef.current = abortController

    setMusicError(null)
    setIsMusicGenerating(true)
    setMusicProgress('Preparing local music generation...')
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
          generationError instanceof Error ? generationError.message : 'Failed to generate music.',
        )
      }
    } finally {
      musicAbortRef.current = null
      setIsMusicGenerating(false)
      setMusicProgress(null)
      setMusicProgressPct(null)
    }
  }, [currentProjectId, trimmedMusicPrompt, isMusicSupported, musicModel, musicDuration])

  const handleMusicCancel = useCallback(() => {
    musicAbortRef.current?.abort()
  }, [])

  const handleImageGenerate = useCallback(async () => {
    if (!currentProjectId) {
      setImageError('Open a project before generating images.')
      return
    }
    if (!isCustomImageGeneratorConfigured) {
      setImageError(
        'Configure base URL, API key, and model in Settings → AI → Custom AI → Image Generator.',
      )
      return
    }
    const trimmedPrompt = imagePrompt.trim()
    if (trimmedPrompt.length === 0) {
      setImageError('Enter a prompt describing the image to generate.')
      return
    }

    setImageError(null)
    setIsImageGenerating(true)
    const controller = new AbortController()
    imageAbortRef.current = controller
    try {
      const aspectLabel = imageAspect === 'auto' ? '' : imageAspect
      const finalPrompt = buildFreeformImagePrompt({
        prompt: trimmedPrompt,
        aspectLabel,
        cast: imageCast,
        style: imageStyle,
        mood: imageMood,
        customNotes: imageCustomNotes,
      })
      const dims = resolveImageDimensions(imageAspect, projectCanvasWidth, projectCanvasHeight)
      const apiQuality = resolvePosterQualityApiValue(imageQuality)
      const result = await generateCoverImage({
        prompt: finalPrompt,
        width: dims.width,
        height: dims.height,
        ...(apiQuality ? { quality: apiQuality } : {}),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      const objectUrl = URL.createObjectURL(result.blob)
      generationUrlsRef.current.add(objectUrl)
      // Preserve the original mime / extension so the saved media file matches
      // what the API actually returned (PNG by default, sometimes WebP/JPEG).
      const mime = result.mimeType || result.blob.type || 'image/png'
      const subtype = mime.split('/')[1]?.split(';')[0] ?? 'png'
      const extension = subtype === 'jpeg' ? 'jpg' : subtype
      const fileName = `ai-image-${Date.now()}.${extension}`
      const file = new File([result.blob], fileName, { type: mime })
      const aspectOpt = ASPECT_RATIO_OPTIONS.find((o) => o.value === imageAspect)
      const aspectLabelForRow =
        imageAspect === 'auto'
          ? `canvas (${projectCanvasWidth}×${projectCanvasHeight})`
          : (aspectOpt?.label ?? imageAspect)

      const generation: ImageGeneration = {
        id: crypto.randomUUID(),
        file,
        blob: result.blob,
        objectUrl,
        byteSize: result.blob.size,
        width: result.width || dims.width,
        height: result.height || dims.height,
        promptSnippet: trimmedPrompt,
        details: `${aspectLabelForRow} / ${result.width || dims.width}×${result.height || dims.height} / ${formatBytes(result.blob.size)}`,
        tags: [
          'ai-generated',
          'image-generator',
          'image-generator:freeform',
          `image-generator-model:${imageGeneratorConfig.model}`,
          ...(imageCast !== 'auto' ? [`image-generator-cast:${imageCast}`] : []),
          ...(imageStyle !== 'auto' ? [`image-generator-style:${imageStyle}`] : []),
        ],
        savedMediaId: null,
        saving: false,
      }
      setImageGenerations((prev) => [generation, ...prev])
    } catch (generationError) {
      if (generationError instanceof DOMException && generationError.name === 'AbortError') {
        // Intentional cancellation — no error shown.
      } else {
        setImageError(
          generationError instanceof Error ? generationError.message : 'Failed to generate image.',
        )
      }
    } finally {
      imageAbortRef.current = null
      setIsImageGenerating(false)
    }
  }, [
    currentProjectId,
    imageAspect,
    imageCast,
    imageCustomNotes,
    imageGeneratorConfig.model,
    imageMood,
    imagePrompt,
    imageQuality,
    imageStyle,
    isCustomImageGeneratorConfigured,
    projectCanvasHeight,
    projectCanvasWidth,
  ])

  const handleImageCancel = useCallback(() => {
    imageAbortRef.current?.abort()
  }, [])

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
        setImageError(
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
  const trimmedImagePrompt = imagePrompt.trim()

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
            : 'Failed to save audio to the media library.',
        )
        updateGenerationInList(setGenerations, generation.id, { saving: false })
        return null
      }
    },
    [currentProjectId, loadMediaItems, selectMedia, updateGenerationInList],
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
          message: `Saved "${media.fileName}" to the media library.`,
        })
      }
    },
    [saveGeneration, showNotification],
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
          ? `Saved "${media.fileName}" and added to timeline.`
          : `Saved "${media.fileName}" but no audio track is available.`,
      })
    },
    [saveGeneration, showNotification],
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
                aria-label={ttsSectionOpen ? 'Collapse text to speech' : 'Expand text to speech'}
              >
                <h2 className="text-sm font-medium">Text to Speech</h2>
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
                  ? 'WebGPU is not available in this browser. Kokoro TTS needs Chrome 113+, Edge 113+, or Safari 26+.'
                  : ttsEngine === 'moss'
                    ? 'Browser-managed storage is not available in this browser. MOSS multilingual TTS works best in a recent Chromium browser.'
                    : 'Configure Base URL, API key, and model in Settings → AI → Custom AI → Text to Speech.'}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="ai-tts-text">Text</Label>
              <Textarea
                id="ai-tts-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Enter the text you want to hear spoken..."
                className="min-h-24 resize-y bg-secondary/30 text-sm"
                disabled={isGenerating}
              />
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Engine</Label>
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
                      Kokoro (English, WebGPU)
                    </SelectItem>
                    <SelectItem value="moss" className="text-xs">
                      MOSS Nano (20 languages, CPU)
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
                    <Label>Voice</Label>
                    <Select
                      value={voice}
                      onValueChange={(value) => {
                        if (ttsEngine === 'kokoro') {
                          setTtsKokoroVoice(value as KokoroTtsVoice)
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
                          : MOSS_TTS_VOICE_OPTIONS
                        ).map((option) => (
                          <SelectItem key={option.value} value={option.value} className="text-xs">
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
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
                  label="Speed"
                  value={speed}
                  onChange={setSpeed}
                  min={0.5}
                  max={2}
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
                {isGenerating ? 'Generating...' : 'Generate'}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {isCustomTtsEngine
                ? `${currentTtsRuntimeLabel} sends each request to your configured ${currentTtsBackendLabel} endpoint.`
                : `${currentTtsRuntimeLabel} runs locally in the browser on ${currentTtsBackendLabel}.`}
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
                    History ({generations.length}) - {formatBytes(totalBytes)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
                    onClick={handleClearAll}
                    disabled={anySaving}
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear all
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
                    musicSectionOpen ? 'Collapse music generation' : 'Expand music generation'
                  }
                >
                  <h2 className="text-sm font-medium">Music Generation</h2>
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
                    aria-label="Music generation info"
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
                    Uses Xenova&apos;s browser-ready MusicGen model through Transformers.js. The
                    first download is large, then it stays cached locally.
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
                    Prompt with genre, mood, tempo, and instrumentation. Shorter clips finish much
                    faster.
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <CollapsibleContent className="space-y-4 pt-3">
            {!isMusicSupported && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                WebGPU is not available in this browser. MusicGen needs Chrome 113+, Edge 113+, or
                Safari 26+.
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="ai-music-prompt">Prompt</Label>
                <Select
                  value=""
                  onValueChange={(value) => setMusicPrompt(value)}
                  disabled={isMusicGenerating}
                >
                  <SelectTrigger className="h-6 w-auto gap-1 border-none bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none hover:text-foreground">
                    <SelectValue placeholder="Presets" />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {MUSIC_PROMPT_PRESETS.map((preset) => (
                      <SelectItem key={preset.label} value={preset.prompt} className="text-xs">
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                id="ai-music-prompt"
                value={musicPrompt}
                onChange={(event) => setMusicPrompt(event.target.value)}
                placeholder="Describe the kind of music you want to generate..."
                className="min-h-24 resize-y bg-secondary/30 text-sm"
                disabled={isMusicGenerating}
              />
            </div>

            <SliderInput
              label="Length"
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
                  Cancel
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
                {isMusicGenerating ? 'Generating...' : 'Generate Music'}
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
                    Music History ({musicGenerations.length}) - {formatBytes(totalMusicBytes)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
                    onClick={() => clearGenerationList(setMusicGenerations)}
                    disabled={anyMusicSaving}
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear all
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
                  imageSectionOpen ? 'Collapse image generation' : 'Expand image generation'
                }
              >
                <h2 className="text-sm font-medium">Image Generation</h2>
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
            {isCustomImageGeneratorConfigured ? (
              <p className="text-[11px] text-muted-foreground">
                Using model{' '}
                <span className="font-medium text-foreground">{imageGeneratorConfig.model}</span>{' '}
                via {imageGeneratorConfig.baseUrl}.
              </p>
            ) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                Configure base URL, API key, and model in Settings → AI → Custom AI → Image
                Generator before generating.
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="ai-image-prompt">Prompt</Label>
              <Textarea
                id="ai-image-prompt"
                value={imagePrompt}
                onChange={(event) => setImagePrompt(event.target.value)}
                placeholder="Describe the image you want to generate..."
                className="min-h-24 resize-y bg-secondary/30 text-sm"
                disabled={isImageGenerating}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Aspect ratio</Label>
                <Select
                  value={imageAspect}
                  onValueChange={setImageAspect}
                  disabled={isImageGenerating}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECT_RATIO_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
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
                <Label className="text-xs">Cast</Label>
                <Select
                  value={imageCast}
                  onValueChange={(value) => setImageCast(value as PosterCastValue)}
                  disabled={isImageGenerating}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POSTER_CAST_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
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
                  value={imageStyle}
                  onValueChange={(value) => setImageStyle(value as PosterStyleValue)}
                  disabled={isImageGenerating}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POSTER_STYLE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Mood / genre</Label>
                <Select
                  value={imageMood}
                  onValueChange={(value) => setImageMood(value as PosterMoodValue)}
                  disabled={isImageGenerating}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POSTER_MOOD_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
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
                value={imageQuality}
                onValueChange={(value) => setImageQuality(value as PosterQualityValue)}
                disabled={isImageGenerating}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POSTER_QUALITY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-xs">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Honoured by OpenAI <code className="text-foreground">gpt-image-1</code>. Most other
                providers (Gemini, Grok) silently ignore this.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Custom notes (optional)</Label>
              <Input
                value={imageCustomNotes}
                onChange={(event) => setImageCustomNotes(event.target.value)}
                placeholder='e.g. "1990s Jakarta", "rain-soaked alley"'
                className="h-8 text-xs"
                disabled={isImageGenerating}
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              {isImageGenerating && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleImageCancel}
                  className="h-7 shrink-0 gap-1.5 text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => {
                  void handleImageGenerate()
                }}
                disabled={
                  isImageGenerating ||
                  !trimmedImagePrompt ||
                  !currentProjectId ||
                  !isCustomImageGeneratorConfigured
                }
                className="h-7 shrink-0 gap-1.5"
              >
                {isImageGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImageIcon className="h-3.5 w-3.5" />
                )}
                {isImageGenerating ? 'Generating...' : 'Generate Image'}
              </Button>
            </div>

            {imageError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {imageError}
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
                    Clear all
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
            aria-label="Remove"
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
            Saved
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
              {gen.saving ? 'Saving...' : 'Save & Insert'}
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
              Save to Library
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
  const saved = generation.savedMediaId !== null
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

      <ImageLightbox
        src={generation.objectUrl}
        alt={generation.promptSnippet}
        downloadFilename={generation.file.name}
      >
        <button
          type="button"
          className="flex w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md border border-border bg-black"
          aria-label="Open image preview"
        >
          <img
            src={generation.objectUrl}
            alt="Generated image"
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

      <div className="flex flex-wrap items-center gap-1.5">
        {saved ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            Saved to Media Library
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
