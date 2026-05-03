import type { AspectRatioOption } from './aspect-ratio-options'

/** Small SVG glyph that previews each aspect ratio in the dropdown. */
export function AspectRatioIcon({ dim }: { dim: AspectRatioOption['dim'] }) {
  // Box big enough that 21:9 still shows as a visible bar inside it; padding
  // keeps the stroke from clipping against the SVG edge.
  const BOX_W = 22
  const BOX_H = 14
  const PADDING = 1.5
  const innerW = BOX_W - 2 * PADDING
  const innerH = BOX_H - 2 * PADDING

  let rectW = innerW
  let rectH = innerH
  if (dim) {
    const ratio = dim.w / dim.h
    if (ratio >= innerW / innerH) {
      rectW = innerW
      rectH = innerW / ratio
    } else {
      rectH = innerH
      rectW = innerH * ratio
    }
  }
  return (
    <svg
      width={BOX_W}
      height={BOX_H}
      viewBox={`0 0 ${BOX_W} ${BOX_H}`}
      className="shrink-0 text-muted-foreground"
      aria-hidden
    >
      <rect
        x={(BOX_W - rectW) / 2}
        y={(BOX_H - rectH) / 2}
        width={rectW}
        height={rectH}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        rx={1}
        {...(dim ? {} : { strokeDasharray: '2 2' })}
      />
    </svg>
  )
}
