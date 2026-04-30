import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/features/editor/deps/settings'

export function TimelineSection() {
  const snapEnabled = useSettingsStore((s) => s.snapEnabled)
  const showWaveforms = useSettingsStore((s) => s.showWaveforms)
  const showFilmstrips = useSettingsStore((s) => s.showFilmstrips)
  const setSetting = useSettingsStore((s) => s.setSetting)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm">Snap by Default</Label>
          <p className="text-xs text-muted-foreground">
            Sets the initial snap state when a project opens.
          </p>
        </div>
        <Switch checked={snapEnabled} onCheckedChange={(v) => setSetting('snapEnabled', v)} />
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-sm">Show Waveforms</Label>
        <Switch checked={showWaveforms} onCheckedChange={(v) => setSetting('showWaveforms', v)} />
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-sm">Show Filmstrips</Label>
        <Switch checked={showFilmstrips} onCheckedChange={(v) => setSetting('showFilmstrips', v)} />
      </div>
    </div>
  )
}
