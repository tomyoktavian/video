import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RotateCcw, Settings2, Rows3, HardDrive, Sparkles } from 'lucide-react'
import { useSettingsStore } from '@/features/editor/deps/settings'
import { cn } from '@/shared/ui/cn'
import { GeneralSection } from './settings-dialog/general-section'
import { AiSection } from './settings-dialog/ai-section'
import { TimelineSection } from './settings-dialog/timeline-section'
import { StorageSection } from './settings-dialog/storage-section'

const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'timeline', label: 'Timeline', icon: Rows3 },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'storage', label: 'Storage', icon: HardDrive },
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0 sm:top-16 sm:max-h-[calc(100vh-4rem)] sm:translate-y-0 sm:origin-top">
        <DialogHeader className="flex flex-row items-center justify-between border-b px-6 py-4 pr-14">
          <DialogTitle>Editor Settings</DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={resetToDefaults}
            className="h-8 shrink-0 gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </Button>
        </DialogHeader>
        <div className="flex min-h-0">
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-white/6 p-2">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors duration-150 ease-out motion-reduce:transition-none',
                    activeSection === section.id
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-white/5 hover:text-foreground/80',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {section.label}
                </button>
              )
            })}
          </nav>

          <ScrollArea className="max-h-[70vh] min-h-[360px] flex-1">
            <div className="space-y-3 px-6 py-5 pr-7">
              {activeSection === 'general' && <GeneralSection />}
              {activeSection === 'ai' && <AiSection />}
              {activeSection === 'timeline' && <TimelineSection />}
              {activeSection === 'storage' && <StorageSection />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}
