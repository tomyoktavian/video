import { useCallback, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCustomAiStore } from '@/features/editor/deps/settings-contract'
import { fetchCustomAiModels } from '@/features/editor/deps/media-library-contract'

const PLACEHOLDER_BASE_URL = 'https://api.openai.com/v1'

export function ImageGeneratorSection() {
  const { t } = useTranslation()
  const imageGenerator = useCustomAiStore((s) => s.imageGenerator)
  const setImageGenerator = useCustomAiStore((s) => s.setImageGenerator)
  const resetImageGenerator = useCustomAiStore((s) => s.resetImageGenerator)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const modelOptions = useMemo<ComboboxOption[]>(
    () =>
      imageGenerator.cachedModels.map((entry) => ({
        value: entry.id,
        label: entry.label && entry.label !== entry.id ? `${entry.label} (${entry.id})` : entry.id,
      })),
    [imageGenerator.cachedModels],
  )

  const canLoad = Boolean(imageGenerator.baseUrl.trim() && imageGenerator.apiKey.trim())

  const handleLoad = useCallback(async () => {
    if (!canLoad) return
    setLoading(true)
    setError(null)
    try {
      const models = await fetchCustomAiModels(imageGenerator.baseUrl.trim(), imageGenerator.apiKey)
      const stillSelected =
        imageGenerator.model && models.some((entry) => entry.id === imageGenerator.model)
      setImageGenerator({
        cachedModels: models,
        lastLoadedAt: Date.now(),
        model: stillSelected ? imageGenerator.model : (models[0]?.id ?? ''),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.imageGenerator.failedToLoadModels'))
    } finally {
      setLoading(false)
    }
  }, [
    canLoad,
    imageGenerator.apiKey,
    imageGenerator.baseUrl,
    imageGenerator.model,
    setImageGenerator,
    t,
  ])

  const isPristine =
    !imageGenerator.baseUrl &&
    !imageGenerator.apiKey &&
    !imageGenerator.model &&
    imageGenerator.cachedModels.length === 0

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.imageGenerator.baseUrl')}</Label>
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={PLACEHOLDER_BASE_URL}
          value={imageGenerator.baseUrl}
          onChange={(event) => setImageGenerator({ baseUrl: event.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.imageGenerator.apiKey')}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-..."
            value={imageGenerator.apiKey}
            onChange={(event) => setImageGenerator({ apiKey: event.target.value })}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleLoad}
            disabled={!canLoad || loading}
            className="shrink-0"
          >
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {loading ? t('settings.imageGenerator.loading') : t('settings.imageGenerator.load')}
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
        <Label className="text-sm">{t('settings.imageGenerator.model')}</Label>
        <Combobox
          value={imageGenerator.model}
          options={modelOptions}
          onValueChange={(value) => setImageGenerator({ model: value })}
          placeholder={
            modelOptions.length === 0
              ? t('settings.imageGenerator.loadModelsToChoose')
              : t('settings.imageGenerator.selectAModel')
          }
          searchPlaceholder={t('settings.imageGenerator.searchModels')}
          emptyMessage={t('settings.imageGenerator.noModelsLoaded')}
          disabled={modelOptions.length === 0}
        />
        <div className="space-y-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            <Trans
              i18nKey="settings.imageGenerator.modelHint"
              components={{ s: <strong />, c: <code className="text-foreground" /> }}
            />
          </p>
          <p className="text-foreground">
            <Trans
              i18nKey="settings.imageGenerator.recommendedHint"
              components={{ s: <strong />, c: <code className="text-foreground" /> }}
            />
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <Trans
                i18nKey="settings.imageGenerator.geminiHint"
                components={{ s: <strong />, c: <code className="text-foreground" /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="settings.imageGenerator.openaiHint"
                components={{ s: <strong />, c: <code className="text-foreground" /> }}
              />
            </li>
            <li>
              <Trans
                i18nKey="settings.imageGenerator.proxiesHint"
                components={{ s: <strong />, c: <code className="text-foreground" /> }}
              />
            </li>
          </ul>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            setError(null)
            resetImageGenerator()
          }}
          disabled={isPristine}
        >
          {t('settings.imageGenerator.reset')}
        </Button>
      </div>
    </div>
  )
}
