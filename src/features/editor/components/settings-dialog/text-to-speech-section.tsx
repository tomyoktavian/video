import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Pause, Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCustomAiStore } from '@/features/editor/deps/settings-contract'
import {
  fetchCustomAiModels,
  fetchCustomAiVoices,
} from '@/features/editor/deps/media-library-contract'
import { customTtsService } from '@/features/editor/services/custom-tts-service'
import { WHISPER_LANGUAGE_OPTIONS } from '@/shared/utils/whisper-settings'

const PLACEHOLDER_BASE_URL = 'https://api.openai.com/v1'
const PREVIEW_TEXT = 'Hello, this is a preview of my voice.'

export function TextToSpeechSection() {
  const textToSpeech = useCustomAiStore((s) => s.textToSpeech)
  const setTextToSpeech = useCustomAiStore((s) => s.setTextToSpeech)
  const resetTextToSpeech = useCustomAiStore((s) => s.resetTextToSpeech)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [voicesLoadFailed, setVoicesLoadFailed] = useState(false)

  const [previewVoice, setPreviewVoice] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewCacheRef = useRef<Map<string, string>>(new Map())

  // Revoke any cached preview blob URLs when the component unmounts.
  useEffect(() => {
    const cache = previewCacheRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  const modelOptions = useMemo<ComboboxOption[]>(
    () =>
      textToSpeech.cachedModels.map((entry) => ({
        value: entry.id,
        label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
      })),
    [textToSpeech.cachedModels],
  )

  const voiceOptions = useMemo<ComboboxOption[]>(
    () =>
      textToSpeech.cachedVoices.map((entry) => ({
        value: entry.id,
        label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
      })),
    [textToSpeech.cachedVoices],
  )

  const hasDiscoveredVoices = voiceOptions.length > 0
  const canLoad = Boolean(textToSpeech.baseUrl.trim() && textToSpeech.apiKey.trim())
  const canPreview = Boolean(
    textToSpeech.baseUrl.trim() &&
    textToSpeech.apiKey.trim() &&
    textToSpeech.model.trim() &&
    textToSpeech.voice.trim(),
  )

  const handleLoad = useCallback(async () => {
    if (!canLoad) return
    setLoading(true)
    setError(null)
    setVoicesLoadFailed(false)
    try {
      const baseUrl = textToSpeech.baseUrl.trim()
      const apiKey = textToSpeech.apiKey
      const [models, voicesResult] = await Promise.all([
        fetchCustomAiModels(baseUrl, apiKey),
        fetchCustomAiVoices(baseUrl, apiKey).then(
          (voices) => ({ ok: true as const, voices }),
          (voicesError: unknown) => ({ ok: false as const, error: voicesError }),
        ),
      ])

      const stillSelectedModel =
        textToSpeech.model && models.some((entry) => entry.id === textToSpeech.model)
      const voices = voicesResult.ok ? voicesResult.voices : []
      const stillSelectedVoice =
        textToSpeech.voice && voices.some((entry) => entry.id === textToSpeech.voice)

      setTextToSpeech({
        cachedModels: models,
        cachedVoices: voices,
        lastLoadedAt: Date.now(),
        model: stillSelectedModel ? textToSpeech.model : (models[0]?.id ?? ''),
        voice:
          voices.length > 0
            ? stillSelectedVoice
              ? textToSpeech.voice
              : voices[0]!.id
            : textToSpeech.voice,
      })
      if (!voicesResult.ok) setVoicesLoadFailed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models')
    } finally {
      setLoading(false)
    }
  }, [
    canLoad,
    textToSpeech.apiKey,
    textToSpeech.baseUrl,
    textToSpeech.model,
    textToSpeech.voice,
    setTextToSpeech,
  ])

  const stopPreview = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    setPreviewPlaying(false)
    setPreviewVoice(null)
  }, [])

  const playFromUrl = useCallback((voiceId: string, url: string) => {
    let audio = audioRef.current
    if (!audio) {
      audio = new Audio()
      audio.preload = 'auto'
      audio.addEventListener('ended', () => {
        setPreviewPlaying(false)
        setPreviewVoice(null)
      })
      audioRef.current = audio
    }
    audio.src = url
    setPreviewVoice(voiceId)
    setPreviewPlaying(true)
    void audio.play().catch((playError: unknown) => {
      setPreviewError(playError instanceof Error ? playError.message : 'Audio playback failed')
      setPreviewPlaying(false)
      setPreviewVoice(null)
    })
  }, [])

  const handlePreview = useCallback(async () => {
    const voice = textToSpeech.voice.trim()
    if (!voice) return

    if (previewPlaying && previewVoice === voice) {
      stopPreview()
      return
    }

    const cached = previewCacheRef.current.get(voice)
    if (cached) {
      playFromUrl(voice, cached)
      return
    }

    setPreviewError(null)
    setPreviewVoice(voice)
    setPreviewPlaying(false)
    try {
      const { blob } = await customTtsService.generateSpeechFile({
        text: PREVIEW_TEXT,
        speed: 1,
        voice,
      })
      const url = URL.createObjectURL(blob)
      previewCacheRef.current.set(voice, url)
      playFromUrl(voice, url)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to generate preview')
      setPreviewVoice(null)
    }
  }, [textToSpeech.voice, previewPlaying, previewVoice, playFromUrl, stopPreview])

  const handleReset = useCallback(() => {
    setError(null)
    setPreviewError(null)
    setVoicesLoadFailed(false)
    stopPreview()
    for (const url of previewCacheRef.current.values()) URL.revokeObjectURL(url)
    previewCacheRef.current.clear()
    resetTextToSpeech()
  }, [resetTextToSpeech, stopPreview])

  const previewLoading = previewVoice !== null && !previewPlaying
  const isPreviewingCurrentVoice =
    previewPlaying && previewVoice !== null && previewVoice === textToSpeech.voice.trim()

  const isPristine =
    !textToSpeech.baseUrl &&
    !textToSpeech.apiKey &&
    !textToSpeech.model &&
    !textToSpeech.voice &&
    !textToSpeech.language &&
    textToSpeech.cachedModels.length === 0 &&
    textToSpeech.cachedVoices.length === 0

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">Base URL</Label>
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={PLACEHOLDER_BASE_URL}
          value={textToSpeech.baseUrl}
          onChange={(event) => setTextToSpeech({ baseUrl: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">API Key</Label>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-..."
            value={textToSpeech.apiKey}
            onChange={(event) => setTextToSpeech({ apiKey: event.target.value })}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleLoad}
            disabled={!canLoad || loading}
            className="shrink-0"
          >
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {loading ? 'Loading' : 'Load'}
          </Button>
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">Model</Label>
        <Combobox
          value={textToSpeech.model}
          options={modelOptions}
          onValueChange={(value) => setTextToSpeech({ model: value })}
          placeholder={modelOptions.length === 0 ? 'Load models to choose…' : 'Select a model'}
          searchPlaceholder="Search models..."
          emptyMessage="No models loaded yet."
          disabled={modelOptions.length === 0}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm">Voice</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => {
              void handlePreview()
            }}
            disabled={!canPreview || previewLoading}
            aria-label={isPreviewingCurrentVoice ? 'Stop voice preview' : 'Play voice preview'}
          >
            {previewLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : isPreviewingCurrentVoice ? (
              <Pause className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {previewLoading
              ? 'Generating…'
              : isPreviewingCurrentVoice
                ? 'Stop preview'
                : 'Play preview'}
          </Button>
        </div>
        {hasDiscoveredVoices ? (
          <Combobox
            value={textToSpeech.voice}
            options={voiceOptions}
            onValueChange={(value) => {
              stopPreview()
              setTextToSpeech({ voice: value })
            }}
            placeholder="Select a voice"
            searchPlaceholder="Search voices..."
            emptyMessage="No voices match that search."
          />
        ) : (
          <Input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="alloy"
            value={textToSpeech.voice}
            onChange={(event) => {
              stopPreview()
              setTextToSpeech({ voice: event.target.value })
            }}
          />
        )}
        {hasDiscoveredVoices ? (
          <p className="text-xs text-muted-foreground">
            Voices loaded from your provider&apos;s{' '}
            <code className="text-foreground">/audio/voices</code> endpoint. Use{' '}
            <strong>Play preview</strong> to hear the selected voice.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {voicesLoadFailed
              ? 'Your provider doesn’t expose a voice list. Type a voice name supported by your endpoint — for OpenAI, try '
              : 'Load models to discover voices, or type one manually. For OpenAI, try '}
            <code className="text-foreground">alloy</code>,{' '}
            <code className="text-foreground">echo</code>,{' '}
            <code className="text-foreground">fable</code>,{' '}
            <code className="text-foreground">onyx</code>,{' '}
            <code className="text-foreground">nova</code>, or{' '}
            <code className="text-foreground">shimmer</code>.
          </p>
        )}
        {previewError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          >
            {previewError}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">Language</Label>
        <Combobox
          value={textToSpeech.language || 'auto'}
          options={WHISPER_LANGUAGE_OPTIONS}
          onValueChange={(value) => setTextToSpeech({ language: value === 'auto' ? '' : value })}
          placeholder="Auto-detect"
          searchPlaceholder="Search languages..."
          emptyMessage="No languages match that search."
        />
        <p className="text-xs text-muted-foreground">
          Sent to the server as a language hint. <strong>No translation</strong> — text is spoken
          as-is. Pick <strong>Auto-detect</strong> for mixed-language input (handled natively by
          modern TTS like OpenAI <code className="text-foreground">tts-1</code>).
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        Generates speech via an OpenAI-compatible TTS endpoint (POST /audio/speech). Empty voice
        defaults to <code className="text-foreground">alloy</code>.
      </p>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={handleReset}
          disabled={isPristine}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}
