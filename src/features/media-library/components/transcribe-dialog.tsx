import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Square } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Combobox } from '@/components/ui/combobox'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  isCaptionMakerConfigured,
  useCustomAiStore,
  useSettingsStore,
} from '@/features/media-library/deps/settings-contract'
import { cn } from '@/shared/ui/cn'
import { getMediaTranscriptionModelOptions } from '../transcription/registry'
import {
  getWhisperLanguageSelectValue,
  getWhisperLanguageSettingValue,
  normalizeSelectableWhisperModel,
  WHISPER_LANGUAGE_OPTIONS,
  WHISPER_QUANTIZATION_OPTIONS,
} from '@/shared/utils/whisper-settings'
import type { MediaTranscriptModel, MediaTranscriptQuantization } from '@/types/storage'
import { clampWordsPerCaption, MAX_WORDS_PER_CAPTION } from '../utils/caption-items'
import { Input } from '@/components/ui/input'

export type TranscribeDialogProvider = 'local' | 'custom'

export interface TranscribeDialogValues {
  provider: TranscribeDialogProvider
  model: MediaTranscriptModel
  /** Custom-AI model id when `provider === 'custom'`; empty otherwise. */
  customModelId: string
  quantization: MediaTranscriptQuantization
  language: string
  wordsPerCaption: number
}

interface TranscribeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileName: string
  hasTranscript: boolean
  isRunning: boolean
  progressPercent: number | null
  progressLabel: string
  errorMessage?: string | null
  onStart: (values: TranscribeDialogValues) => void
  onCancel: () => void
}

export function TranscribeDialog({
  open,
  onOpenChange,
  fileName,
  hasTranscript,
  isRunning,
  progressPercent,
  progressLabel,
  errorMessage,
  onStart,
  onCancel,
}: TranscribeDialogProps) {
  const { t } = useTranslation()
  const defaultModel = useSettingsStore((s) => s.defaultWhisperModel)
  const defaultQuantization = useSettingsStore((s) => s.defaultWhisperQuantization)
  const defaultLanguage = useSettingsStore((s) => s.defaultWhisperLanguage)
  const defaultWordsPerCaption = useSettingsStore((s) => s.defaultWordsPerCaption)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const customCaptionMaker = useCustomAiStore((s) => s.captionMaker)
  const clearMediaSkimPreview = useEditorStore((s) => s.clearMediaSkimPreview)
  const clearCompoundClipSkimPreview = useEditorStore((s) => s.clearCompoundClipSkimPreview)
  const beginTranscriptionDialog = useEditorStore((s) => s.beginTranscriptionDialog)
  const endTranscriptionDialog = useEditorStore((s) => s.endTranscriptionDialog)

  const modelOptions = useMemo(() => getMediaTranscriptionModelOptions(), [])

  const customConfigured = isCaptionMakerConfigured(customCaptionMaker)

  const [provider, setProvider] = useState<TranscribeDialogProvider>(
    customConfigured ? 'custom' : 'local',
  )
  const [model, setModel] = useState<MediaTranscriptModel>(() =>
    normalizeSelectableWhisperModel(defaultModel),
  )
  const [quantization, setQuantization] = useState<MediaTranscriptQuantization>(defaultQuantization)
  const [languageValue, setLanguageValue] = useState<string>(() =>
    getWhisperLanguageSelectValue(defaultLanguage),
  )
  const [customLanguageValue, setCustomLanguageValue] = useState<string>(() =>
    getWhisperLanguageSelectValue(customCaptionMaker.language),
  )
  const [wordsPerCaption, setWordsPerCaption] = useState<number>(defaultWordsPerCaption)

  useEffect(() => {
    if (!open) return
    // Default to Custom AI when configured; user can manually switch to Local
    // for the duration of this dialog session, but the choice resets each open.
    setProvider(customConfigured ? 'custom' : 'local')
    setModel(normalizeSelectableWhisperModel(defaultModel))
    setQuantization(defaultQuantization)
    setLanguageValue(getWhisperLanguageSelectValue(defaultLanguage))
    setCustomLanguageValue(getWhisperLanguageSelectValue(customCaptionMaker.language))
    setWordsPerCaption(defaultWordsPerCaption)
  }, [
    open,
    customConfigured,
    defaultLanguage,
    defaultModel,
    defaultQuantization,
    customCaptionMaker.language,
    defaultWordsPerCaption,
  ])

  useEffect(() => {
    if (!open) return
    beginTranscriptionDialog()
    clearMediaSkimPreview()
    clearCompoundClipSkimPreview()
    usePlaybackStore.getState().setPreviewFrame(null)
    usePlaybackStore.getState().pause()

    return () => {
      endTranscriptionDialog()
    }
  }, [
    beginTranscriptionDialog,
    clearCompoundClipSkimPreview,
    clearMediaSkimPreview,
    endTranscriptionDialog,
    open,
  ])

  const handleStart = () => {
    const normalizedWordsPerCaption = clampWordsPerCaption(wordsPerCaption)
    setSetting('defaultWordsPerCaption', normalizedWordsPerCaption)
    if (provider === 'custom') {
      onStart({
        provider: 'custom',
        model,
        customModelId: customCaptionMaker.model,
        quantization,
        language: getWhisperLanguageSettingValue(customLanguageValue),
        wordsPerCaption: normalizedWordsPerCaption,
      })
      return
    }
    onStart({
      provider: 'local',
      model,
      customModelId: '',
      quantization,
      language: getWhisperLanguageSettingValue(languageValue),
      wordsPerCaption: normalizedWordsPerCaption,
    })
  }

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isRunning && !nextOpen) {
        return
      }
      onOpenChange(nextOpen)
    },
    [isRunning, onOpenChange],
  )

  const title = hasTranscript
    ? t('media.transcribe.refreshTitle')
    : t('media.transcribe.generateTitle')

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal>
      <DialogContent
        className="sm:max-w-md"
        hideCloseButton={isRunning}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (isRunning) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="truncate">{fileName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center rounded-md border border-border bg-secondary p-0.5">
            {(['local', 'custom'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setProvider(value)}
                disabled={isRunning}
                className={cn(
                  'flex-1 rounded px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                  provider === value
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {value === 'local'
                  ? t('media.transcribe.providerLocal')
                  : t('media.transcribe.providerCustom')}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm" htmlFor="transcribe-words-per-caption">
              {t('media.transcribe.wordsPerCaption')}
            </Label>
            <Input
              id="transcribe-words-per-caption"
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
                ? t('media.transcribe.wordsPerCaptionHintKaraoke')
                : t('media.transcribe.wordsPerCaptionHint', { count: wordsPerCaption })}
            </p>
          </div>

          {provider === 'local' ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-sm">{t('media.transcribe.model')}</Label>
                <Select
                  value={model}
                  onValueChange={(value) => setModel(value as MediaTranscriptModel)}
                  disabled={isRunning}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">{t('media.transcribe.quantization')}</Label>
                <Select
                  value={quantization}
                  onValueChange={(value) => setQuantization(value as MediaTranscriptQuantization)}
                  disabled={isRunning}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WHISPER_QUANTIZATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm">{t('media.transcribe.language')}</Label>
                <Combobox
                  value={languageValue}
                  onValueChange={setLanguageValue}
                  options={WHISPER_LANGUAGE_OPTIONS}
                  placeholder={t('media.transcribe.autoDetect')}
                  searchPlaceholder={t('media.transcribe.searchLanguages')}
                  emptyMessage={t('media.transcribe.noLanguages')}
                  disabled={isRunning}
                />
              </div>
            </>
          ) : (
            <>
              {customConfigured ? (
                <p className="text-xs text-muted-foreground">
                  {t('media.transcribe.customUsingModel', {
                    model: customCaptionMaker.model,
                    baseUrl: customCaptionMaker.baseUrl,
                  })}
                </p>
              ) : (
                <p
                  role="alert"
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
                >
                  {t('media.transcribe.customConfigureHint')}
                </p>
              )}

              <div className="space-y-1.5">
                <Label className="text-sm">{t('media.transcribe.language')}</Label>
                <Combobox
                  value={customLanguageValue}
                  onValueChange={setCustomLanguageValue}
                  options={WHISPER_LANGUAGE_OPTIONS}
                  placeholder={t('media.transcribe.autoDetect')}
                  searchPlaceholder={t('media.transcribe.searchLanguages')}
                  emptyMessage={t('media.transcribe.noLanguages')}
                  disabled={isRunning}
                />
              </div>
            </>
          )}

          {errorMessage && !isRunning && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {errorMessage}
            </div>
          )}

          {isRunning && (
            <div className="space-y-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="truncate">{progressLabel}</span>
              </div>
              {progressPercent !== null && (
                <div
                  role="progressbar"
                  aria-label={t('media.transcribe.progressAria')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                  className="h-1 overflow-hidden rounded-full bg-secondary"
                >
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {isRunning ? (
            <Button variant="destructive" onClick={onCancel}>
              <Square className="mr-1.5 h-3.5 w-3.5" />
              {t('media.transcribe.stop')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleStart} disabled={provider === 'custom' && !customConfigured}>
                {t('media.transcribe.start')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
