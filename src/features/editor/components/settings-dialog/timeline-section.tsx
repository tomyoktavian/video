import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/features/editor/deps/settings'

export function TimelineSection() {
  const { t } = useTranslation()
  const snapEnabled = useSettingsStore((s) => s.snapEnabled)
  const showWaveforms = useSettingsStore((s) => s.showWaveforms)
  const showFilmstrips = useSettingsStore((s) => s.showFilmstrips)
  const setSetting = useSettingsStore((s) => s.setSetting)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm">{t('settings.timeline.snapByDefault')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.timeline.snapByDefaultDescription')}
          </p>
        </div>
        <Switch checked={snapEnabled} onCheckedChange={(v) => setSetting('snapEnabled', v)} />
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('settings.timeline.showWaveforms')}</Label>
        <Switch checked={showWaveforms} onCheckedChange={(v) => setSetting('showWaveforms', v)} />
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('settings.timeline.showFilmstrips')}</Label>
        <Switch checked={showFilmstrips} onCheckedChange={(v) => setSetting('showFilmstrips', v)} />
      </div>
    </div>
  )
}
