import { useCallback, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCustomAiStore } from '@/features/editor/deps/settings-contract'
import { fetchCustomAiModels } from '@/features/editor/deps/media-library-contract'
import { WHISPER_LANGUAGE_OPTIONS } from '@/shared/utils/whisper-settings'

const PLACEHOLDER_BASE_URL = 'https://api.openai.com/v1'

export function CaptionMakerSection() {
  const { t } = useTranslation()
  const captionMaker = useCustomAiStore((s) => s.captionMaker)
  const setCaptionMaker = useCustomAiStore((s) => s.setCaptionMaker)
  const resetCaptionMaker = useCustomAiStore((s) => s.resetCaptionMaker)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const modelOptions = useMemo<ComboboxOption[]>(
    () =>
      captionMaker.cachedModels.map((entry) => ({
        value: entry.id,
        label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
      })),
    [captionMaker.cachedModels],
  )

  const canLoad = Boolean(captionMaker.baseUrl.trim() && captionMaker.apiKey.trim())

  const handleLoad = useCallback(async () => {
    if (!canLoad) return
    setLoading(true)
    setError(null)
    try {
      const models = await fetchCustomAiModels(captionMaker.baseUrl.trim(), captionMaker.apiKey)
      const stillSelected =
        captionMaker.model && models.some((entry) => entry.id === captionMaker.model)
      setCaptionMaker({
        cachedModels: models,
        lastLoadedAt: Date.now(),
        model: stillSelected ? captionMaker.model : (models[0]?.id ?? ''),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.captionMaker.failedToLoadModels'))
    } finally {
      setLoading(false)
    }
  }, [canLoad, captionMaker.apiKey, captionMaker.baseUrl, captionMaker.model, setCaptionMaker, t])

  const isPristine =
    !captionMaker.baseUrl &&
    !captionMaker.apiKey &&
    !captionMaker.model &&
    !captionMaker.language &&
    captionMaker.cachedModels.length === 0

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.captionMaker.baseUrl')}</Label>
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={PLACEHOLDER_BASE_URL}
          value={captionMaker.baseUrl}
          onChange={(event) => setCaptionMaker({ baseUrl: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.captionMaker.apiKey')}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-..."
            value={captionMaker.apiKey}
            onChange={(event) => setCaptionMaker({ apiKey: event.target.value })}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleLoad}
            disabled={!canLoad || loading}
            className="shrink-0"
          >
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {loading ? t('settings.captionMaker.loading') : t('settings.captionMaker.load')}
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
        <Label className="text-sm">{t('settings.captionMaker.model')}</Label>
        <Combobox
          value={captionMaker.model}
          options={modelOptions}
          onValueChange={(value) => setCaptionMaker({ model: value })}
          placeholder={
            modelOptions.length === 0
              ? t('settings.captionMaker.loadModelsToChoose')
              : t('settings.captionMaker.selectAModel')
          }
          searchPlaceholder={t('settings.captionMaker.searchModels')}
          emptyMessage={t('settings.captionMaker.noModelsLoaded')}
          disabled={modelOptions.length === 0}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.captionMaker.language')}</Label>
        <Combobox
          value={captionMaker.language || 'auto'}
          options={WHISPER_LANGUAGE_OPTIONS}
          onValueChange={(value) => setCaptionMaker({ language: value === 'auto' ? '' : value })}
          placeholder={t('settings.captionMaker.autoDetect')}
          searchPlaceholder={t('settings.captionMaker.searchLanguages')}
          emptyMessage={t('settings.captionMaker.noLanguagesMatch')}
        />
      </div>

      <p className="text-xs text-muted-foreground">{t('settings.captionMaker.summaryHint')}</p>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            setError(null)
            resetCaptionMaker()
          }}
          disabled={isPristine}
        >
          {t('settings.captionMaker.reset')}
        </Button>
      </div>
    </div>
  )
}
