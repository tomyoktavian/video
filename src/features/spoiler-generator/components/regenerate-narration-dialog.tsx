import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RotateCw, Square } from 'lucide-react'

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
import { useRegenerateNarrationDialogStore } from '@/app/state/regenerate-narration-dialog'

import { isTextToSpeechConfigured, useCustomAiStore } from '../deps/settings'
import { useCompositionsStore } from '../deps/timeline'
import { regenerateNarration, type RegenProgress } from '../regenerate-narration-service'

const NARRATION_LANGUAGE_OPTIONS: ComboboxOption[] = [
  { value: 'id', label: 'Indonesian' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese (Mandarin)' },
]

const SPEED_BOUNDS = { min: 0.5, max: 2.0 }

export function RegenerateNarrationDialog() {
  const isOpen = useRegenerateNarrationDialogStore((s) => s.isOpen)
  const compositionId = useRegenerateNarrationDialogStore((s) => s.compositionId)
  const close = useRegenerateNarrationDialogStore((s) => s.close)

  const composition = useCompositionsStore((s) =>
    compositionId ? s.compositionById[compositionId] : undefined,
  )
  const metadata = composition?.spoilerMetadata
  const textToSpeech = useCustomAiStore((s) => s.textToSpeech)
  const ttsConfigured = isTextToSpeechConfigured(textToSpeech)

  const voiceOptions: ComboboxOption[] = useMemo(
    () =>
      textToSpeech.cachedVoices.map((entry) => ({
        value: entry.id,
        label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
      })),
    [textToSpeech.cachedVoices],
  )

  const [voice, setVoice] = useState<string>('')
  const [speed, setSpeed] = useState<number>(1)
  const [language, setLanguage] = useState<string>('id')

  const [step, setStep] = useState<'settings' | 'progress'>('settings')
  const [progress, setProgress] = useState<RegenProgress | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Hydrate form with metadata defaults each time the dialog opens.
  useEffect(() => {
    if (!isOpen || !metadata) return
    setVoice(metadata.voiceId ?? '')
    setSpeed(metadata.speed)
    setLanguage(metadata.language)
    setStep('settings')
    setProgress(null)
    setErrorMessage(null)
    setIsRunning(false)
  }, [isOpen, metadata])

  const handleStart = useCallback(async () => {
    if (!compositionId || !metadata) return
    const controller = new AbortController()
    abortRef.current = controller
    setStep('progress')
    setProgress({ stage: 'idle', message: 'Starting...' })
    setErrorMessage(null)
    setIsRunning(true)
    try {
      await regenerateNarration(
        {
          compositionId,
          voiceId: voice ? voice : null,
          speed,
          language,
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
  }, [compositionId, metadata, voice, speed, language])

  const handleCancelRun = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleClose = useCallback(() => {
    if (isRunning) return
    close()
  }, [close, isRunning])

  if (!isOpen) return null

  const canRun = !!metadata && ttsConfigured && !isRunning

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
            <RotateCw className="h-4 w-4 text-primary" />
            Regenerate Narration
          </AlertDialogTitle>
          <AlertDialogDescription>
            Re-run TTS for this spoiler with a different voice, speed, or language. The compound's
            video, cover, and structure are preserved — only narration audio (and subtitles if
            enabled) are rebuilt.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step === 'settings' && (
          <div className="space-y-3">
            {!metadata && (
              <Alert variant="error">
                This compound was not generated by the Spoiler Generator. Regeneration requires the
                original generation metadata.
              </Alert>
            )}
            {metadata && !ttsConfigured && (
              <Alert variant="error">
                Text to Speech is not configured. Open{' '}
                <strong>Settings → AI → Custom AI → Text to Speech</strong>.
              </Alert>
            )}

            {metadata && (
              <>
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <div>
                    <strong className="text-foreground">{metadata.segments.length}</strong> segment
                    {metadata.segments.length !== 1 ? 's' : ''} ·{' '}
                    {metadata.scriptTitle || 'Untitled spoiler'}
                  </div>
                  <div className="mt-0.5">
                    Original voice: {metadata.voiceId || 'default'} · speed {metadata.speed} ·{' '}
                    language {metadata.language}
                  </div>
                </div>

                {voiceOptions.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-sm">Narration Voice</Label>
                    <Combobox
                      value={voice}
                      options={voiceOptions}
                      onValueChange={setVoice}
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
                    min={SPEED_BOUNDS.min}
                    max={SPEED_BOUNDS.max}
                    step={0.1}
                    value={speed}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      if (Number.isFinite(next)) {
                        setSpeed(Math.min(SPEED_BOUNDS.max, Math.max(SPEED_BOUNDS.min, next)))
                      }
                    }}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">Narration Language</Label>
                  <Combobox
                    value={language}
                    options={NARRATION_LANGUAGE_OPTIONS}
                    onValueChange={setLanguage}
                    placeholder="Select language"
                  />
                </div>

                {metadata.addSubtitles && (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    Subtitles will be rebuilt to match the new narration timing using the original
                    text (no re-transcription, no extra API tokens).
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {step === 'progress' && (
          <div className="space-y-3">
            {progress && (
              <div className="space-y-2">
                <p className="text-sm">{progress.message}</p>
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
              <Alert variant="success">Narration regenerated. Open the compound to preview.</Alert>
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
                <RotateCw className="mr-1.5 h-4 w-4" />
                Regenerate
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
  variant: 'error' | 'success'
  children: React.ReactNode
}

function Alert(props: AlertProps) {
  const styles =
    props.variant === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${styles}`} role="alert">
      {props.children}
    </div>
  )
}
