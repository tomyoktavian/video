import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RotateCw, Square } from 'lucide-react'
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
import { useRegenerateNarrationDialogStore } from '@/app/state/regenerate-narration-dialog'

import { isTextToSpeechConfigured, useCustomAiStore } from '../deps/settings'
import { useCompositionsStore } from '../deps/timeline'
import { regenerateNarration, type RegenProgress } from '../regenerate-narration-service'

const SPEED_BOUNDS = { min: 0.5, max: 2.0 }

export function RegenerateNarrationDialog() {
  const { t } = useTranslation()
  const isOpen = useRegenerateNarrationDialogStore((s) => s.isOpen)
  const compositionId = useRegenerateNarrationDialogStore((s) => s.compositionId)
  const close = useRegenerateNarrationDialogStore((s) => s.close)

  const composition = useCompositionsStore((s) =>
    compositionId ? s.compositionById[compositionId] : undefined,
  )
  const metadata = composition?.spoilerMetadata
  const textToSpeech = useCustomAiStore((s) => s.textToSpeech)
  const ttsConfigured = isTextToSpeechConfigured(textToSpeech)

  const narrationLanguageOptions: ComboboxOption[] = useMemo(
    () => [
      { value: 'id', label: t('spoiler.dialog.langIndonesian') },
      { value: 'en', label: t('spoiler.dialog.langEnglish') },
      { value: 'es', label: t('spoiler.dialog.langSpanish') },
      { value: 'ja', label: t('spoiler.dialog.langJapanese') },
      { value: 'ko', label: t('spoiler.dialog.langKorean') },
      { value: 'zh', label: t('spoiler.dialog.langChinese') },
    ],
    [t],
  )

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
    setProgress({ stage: 'idle', message: t('spoiler.regenerate.starting') })
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
        setProgress({ stage: 'idle', message: t('spoiler.regenerate.cancelled') })
      } else {
        setErrorMessage(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }, [compositionId, metadata, voice, speed, language, t])

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
            {t('spoiler.regenerate.title')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('spoiler.regenerate.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        {step === 'settings' && (
          <div className="space-y-3">
            {!metadata && (
              <Alert variant="error">{t('spoiler.regenerate.notFromSpoilerGenerator')}</Alert>
            )}
            {metadata && !ttsConfigured && (
              <Alert variant="error">
                <Trans
                  i18nKey="spoiler.regenerate.ttsNotConfigured"
                  components={{ strong: <strong /> }}
                />
              </Alert>
            )}

            {metadata && (
              <>
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <div>
                    <strong className="text-foreground">{metadata.segments.length}</strong>{' '}
                    {metadata.segments.length === 1 ? 'segment' : 'segments'} ·{' '}
                    {metadata.scriptTitle || t('spoiler.regenerate.untitled')}
                  </div>
                  <div className="mt-0.5">
                    {t('spoiler.regenerate.originalSettings', {
                      voice: metadata.voiceId || t('spoiler.regenerate.defaultVoice'),
                      speed: metadata.speed,
                      language: metadata.language,
                    })}
                  </div>
                </div>

                {voiceOptions.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-sm">{t('spoiler.regenerate.narrationVoice')}</Label>
                    <Combobox
                      value={voice}
                      options={voiceOptions}
                      onValueChange={setVoice}
                      placeholder={t('spoiler.regenerate.voicePlaceholder')}
                      searchPlaceholder={t('spoiler.regenerate.searchVoices')}
                      emptyMessage={t('spoiler.regenerate.emptyVoices')}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label className="text-sm">{t('spoiler.regenerate.narrationSpeed')}</Label>
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
                  <Label className="text-sm">{t('spoiler.regenerate.narrationLanguage')}</Label>
                  <Combobox
                    value={language}
                    options={narrationLanguageOptions}
                    onValueChange={setLanguage}
                    placeholder={t('spoiler.regenerate.selectLanguage')}
                  />
                </div>

                {metadata.addSubtitles && (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {t('spoiler.regenerate.subtitlesNote')}
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
                      {t('spoiler.regenerate.segmentProgress', {
                        current: progress.segmentIndex,
                        total: progress.segmentTotal,
                      })}
                    </p>
                  )}
              </div>
            )}
            {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
            {progress?.stage === 'done' && !errorMessage && (
              <Alert variant="success">{t('spoiler.regenerate.regenerated')}</Alert>
            )}
          </div>
        )}

        <AlertDialogFooter>
          {step === 'settings' && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                {t('spoiler.regenerate.cancel')}
              </Button>
              <Button onClick={handleStart} disabled={!canRun}>
                <RotateCw className="mr-1.5 h-4 w-4" />
                {t('spoiler.regenerate.regenerate')}
              </Button>
            </>
          )}
          {step === 'progress' && (
            <>
              {isRunning && (
                <Button variant="ghost" onClick={handleCancelRun}>
                  <Square className="mr-1.5 h-4 w-4" />
                  {t('spoiler.regenerate.cancel')}
                </Button>
              )}
              {!isRunning && (
                <>
                  <Button variant="ghost" onClick={() => setStep('settings')}>
                    {t('spoiler.regenerate.back')}
                  </Button>
                  <Button onClick={handleClose}>{t('spoiler.regenerate.close')}</Button>
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
