/**
 * Static visual preview of a text-style preset.
 *
 * Pure CSS approximation (no live composition rendering, no GPU). Used by:
 *   - the Text Templates panel in `media-sidebar.tsx` (the source of these
 *     preview shapes), and
 *   - the Find Highlights dialog's title-template picker.
 *
 * Adding a new preset means: register its `previewKind` in the union below
 * and add a matching branch here.
 */

import { Type } from 'lucide-react'

import type { TextStylePreset } from '@/shared/typography/text-style-presets'

export const TEXT_TEMPLATE_PREVIEW_SHELL =
  'w-full aspect-video rounded-sm border border-border bg-slate-950'

interface TextTemplatePreviewProps {
  preset?: TextStylePreset
}

export function TextTemplatePreview({ preset }: TextTemplatePreviewProps) {
  if (!preset) {
    return (
      <div
        className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex flex-col items-center justify-center gap-1`}
      >
        <Type className="w-3.5 h-3.5 text-muted-foreground/80" />
        <div className="text-[9px] leading-none tracking-wide text-muted-foreground/80 uppercase">
          Text
        </div>
      </div>
    )
  }

  const copy = preset.sample

  if (preset.previewKind === 'clean') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex items-center justify-center px-1.5`}>
        <div className="text-[10px] font-bold tracking-[-0.05em] text-white uppercase leading-none">
          {copy.title}
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'lower-third') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} relative overflow-hidden`}>
        <div className="absolute inset-x-1.5 bottom-1.5 rounded-sm bg-slate-800/95 px-1.5 py-1 text-left">
          <div className="text-[8px] font-semibold leading-none text-slate-50">{copy.title}</div>
          <div className="mt-0.5 text-[7px] leading-none text-slate-300">{copy.subtitle}</div>
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'poster') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex items-center justify-center px-1.5`}>
        <div className="text-[12px] tracking-[-0.05em] text-amber-100 uppercase leading-none [text-shadow:0_2px_10px_rgba(127,29,29,0.85)]">
          {copy.title}
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'outline-pill') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex items-center justify-center px-1.5`}>
        <div className="rounded-full border border-sky-400/70 bg-slate-900 px-2 py-1 text-[7px] font-bold tracking-[0.18em] text-slate-100 uppercase leading-none">
          {copy.title}
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'cinematic') {
    return (
      <div
        className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex flex-col items-center justify-center px-1`}
      >
        <div className="text-[11px] tracking-[0.28em] text-amber-100 uppercase leading-none [text-shadow:0_2px_8px_rgba(17,24,39,0.9)]">
          {copy.title}
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'quote') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} p-1.5 flex items-center justify-center`}>
        <div className="w-full rounded-sm bg-slate-800 px-2 py-1.5 text-center">
          <div className="text-[8px] italic leading-tight text-slate-50">{copy.title}</div>
          <div className="mt-0.5 text-[7px] leading-none tracking-[0.08em] text-slate-300">
            {copy.subtitle}
          </div>
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'speaker') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} px-1.5 py-1 flex flex-col justify-end`}>
        <div className="rounded-sm bg-slate-800/95 px-1.5 py-1">
          <div className="text-[8px] font-bold leading-none text-slate-50">{copy.title}</div>
          <div className="mt-0.5 text-[7px] leading-none text-slate-300">{copy.subtitle}</div>
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'neon') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} p-1.5 flex items-center justify-center`}>
        <div className="w-full rounded-sm bg-cyan-950 px-1.5 py-1.5 text-center">
          <div className="text-[10px] font-semibold tracking-[0.16em] text-cyan-300 drop-shadow-[0_0_6px_rgba(34,211,238,0.85)] uppercase">
            {copy.title}
          </div>
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'stacked') {
    return (
      <div
        className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex flex-col items-center justify-center px-1.5`}
      >
        <div className="text-[6px] font-semibold tracking-[0.2em] text-amber-300 uppercase">
          {copy.eyebrow}
        </div>
        <div className="mt-1 text-[10px] font-bold tracking-[-0.04em] text-white leading-none">
          {copy.title}
        </div>
        <div className="mt-0.5 text-[7px] leading-none text-slate-300">{copy.subtitle}</div>
      </div>
    )
  }

  if (preset.previewKind === 'breaking') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} p-1.5 flex items-center justify-center`}>
        <div className="w-full rounded-sm bg-slate-900 px-1.5 py-1 text-left">
          <div className="text-[6px] font-bold tracking-[0.18em] text-red-300 uppercase leading-none">
            {copy.eyebrow}
          </div>
          <div className="mt-1 text-[9px] font-bold tracking-[-0.04em] text-slate-50 leading-none">
            {copy.title}
          </div>
          <div className="mt-0.5 text-[7px] font-semibold leading-none text-amber-200">
            {copy.subtitle}
          </div>
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'launch') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} p-1.5 flex items-center justify-center`}>
        <div className="w-full rounded-sm border border-blue-800/80 bg-slate-900 px-1.5 py-1 text-center">
          <div className="text-[6px] font-bold tracking-[0.22em] text-cyan-300 uppercase">
            {copy.eyebrow}
          </div>
          <div className="mt-1 text-[9px] font-bold tracking-[-0.04em] text-slate-50 leading-tight">
            {copy.title}
          </div>
          <div className="mt-0.5 text-[7px] leading-none text-blue-200">{copy.subtitle}</div>
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'event') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} p-1.5 flex items-center justify-center`}>
        <div className="w-full rounded-sm bg-slate-900 px-1.5 py-1 text-center">
          <div className="text-[6px] font-bold tracking-[0.22em] text-rose-300 uppercase">
            {copy.eyebrow}
          </div>
          <div className="mt-1 text-[9px] font-bold text-slate-50 leading-tight">{copy.title}</div>
          <div className="mt-0.5 text-[7px] text-blue-200 leading-none uppercase">
            {copy.subtitle}
          </div>
        </div>
      </div>
    )
  }

  if (preset.previewKind === 'badge') {
    return (
      <div className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex items-center justify-center px-1.5`}>
        <div className="rounded-full border border-slate-600 bg-slate-800 px-2 py-1 text-[7px] font-bold tracking-[0.18em] text-slate-50 uppercase leading-none">
          {copy.title}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`${TEXT_TEMPLATE_PREVIEW_SHELL} flex flex-col items-center justify-center px-1.5`}
    >
      <div className="text-[10px] font-bold tracking-[-0.04em] text-white uppercase leading-none">
        {copy.title}
      </div>
      <div className="mt-0.5 text-[7px] leading-none text-slate-300 uppercase">{copy.subtitle}</div>
    </div>
  )
}
