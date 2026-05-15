import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { useSettingsStore } from '@/features/editor/deps/settings'
import { EDITOR_DENSITY_PRESETS, type EditorDensityPresetName } from '@/app/editor-layout'

const EDITOR_DENSITY_OPTIONS: ReadonlyArray<{ value: EditorDensityPresetName; labelKey: string }> =
  (Object.keys(EDITOR_DENSITY_PRESETS) as EditorDensityPresetName[]).map((value) => ({
    value,
    labelKey: `settings.general.density_${value}`,
  }))

export function GeneralSection() {
  const { t } = useTranslation()
  const editorDensity = useSettingsStore((s) => s.editorDensity)
  const autoSaveInterval = useSettingsStore((s) => s.autoSaveInterval)
  const maxUndoHistory = useSettingsStore((s) => s.maxUndoHistory)
  const setSetting = useSettingsStore((s) => s.setSetting)

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.general.editorDensity')}</Label>
        <Select
          value={editorDensity}
          onValueChange={(value) => setSetting('editorDensity', value as typeof editorDensity)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EDITOR_DENSITY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey, {
                  defaultValue: option.value.charAt(0).toUpperCase() + option.value.slice(1),
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t('settings.general.editorDensityDescription')}
        </p>
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('settings.general.autoSave')}</Label>
        <Switch
          checked={autoSaveInterval > 0}
          onCheckedChange={(v) => setSetting('autoSaveInterval', v ? 2 : 0)}
        />
      </div>
      {autoSaveInterval > 0 && (
        <div className="flex items-center justify-between">
          <Label className="text-sm text-muted-foreground">{t('settings.general.interval')}</Label>
          <div className="w-32 flex items-center gap-2">
            <Slider
              value={[autoSaveInterval]}
              onValueChange={([v]) => setSetting('autoSaveInterval', v || 2)}
              min={2}
              max={30}
              step={1}
            />
            <span className="text-xs text-muted-foreground w-6">
              {t('settings.general.intervalMinutes', { count: autoSaveInterval })}
            </span>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('settings.general.undoHistoryDepth')}</Label>
        <div className="w-32 flex items-center gap-2">
          <Slider
            value={[maxUndoHistory]}
            onValueChange={([v]) => setSetting('maxUndoHistory', v || 10)}
            min={10}
            max={200}
            step={10}
          />
          <span className="text-xs text-muted-foreground w-6">{maxUndoHistory}</span>
        </div>
      </div>
    </div>
  )
}
