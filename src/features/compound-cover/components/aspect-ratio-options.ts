/**
 * Shared aspect-ratio dropdown data + helpers reused across every AI image
 * generator surface (Add Cover dialog, Spoiler Generator AI cover step,
 * sidebar AI Image Generation section). Co-located here so a future option
 * change rolls through every consumer at once.
 */

export interface AspectRatioOption {
  value: string
  label: string
  /**
   * Width:height pair used to draw the icon. `null` is the special
   * "None / Default" option — drawn as a dashed rectangle to signal "no
   * constraint", and substituted into the prompt as an empty aspect line.
   */
  dim: { w: number; h: number } | null
}

export const ASPECT_RATIO_OPTIONS: ReadonlyArray<AspectRatioOption> = [
  { value: 'auto', label: 'None (Default)', dim: null },
  { value: '1:1', label: '1:1 (Square)', dim: { w: 1, h: 1 } },
  { value: '3:2', label: '3:2 (Landscape)', dim: { w: 3, h: 2 } },
  { value: '2:3', label: '2:3 (Portrait)', dim: { w: 2, h: 3 } },
  { value: '3:4', label: '3:4 (Portrait)', dim: { w: 3, h: 4 } },
  { value: '4:1', label: '4:1 (Panoramic)', dim: { w: 4, h: 1 } },
  { value: '4:3', label: '4:3 (Landscape)', dim: { w: 4, h: 3 } },
  { value: '4:5', label: '4:5 (Portrait)', dim: { w: 4, h: 5 } },
  { value: '5:4', label: '5:4 (Landscape)', dim: { w: 5, h: 4 } },
  { value: '8:1', label: '8:1 (Super-wide)', dim: { w: 8, h: 1 } },
  { value: '9:16', label: '9:16 (Portrait)', dim: { w: 9, h: 16 } },
  { value: '16:9', label: '16:9 (Landscape)', dim: { w: 16, h: 9 } },
  { value: '21:9', label: '21:9 (Ultra-wide)', dim: { w: 21, h: 9 } },
]

/**
 * Pick the aspect-ratio dropdown option that best matches a given canvas
 * within ~3 % tolerance. Falls back to `'auto'` ("None / Default") when the
 * canvas's ratio doesn't sit close to any of the canonical buckets — better
 * to leave the prompt unconstrained than to mislabel an unusual canvas.
 */
export function pickAspectRatioFromCanvas(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'auto'
  }
  const target = width / height
  let bestValue = 'auto'
  let bestDelta = Infinity
  for (const opt of ASPECT_RATIO_OPTIONS) {
    if (!opt.dim) continue
    const ratio = opt.dim.w / opt.dim.h
    const delta = Math.abs(ratio - target) / target
    if (delta < bestDelta) {
      bestDelta = delta
      bestValue = opt.value
    }
  }
  return bestDelta <= 0.03 ? bestValue : 'auto'
}

/**
 * Resolve API call dimensions from the user's chosen aspect ratio. Falls
 * back to the project canvas when the user picks "None (Default)". Each
 * adapter further snaps these to its provider-supported sizes, so we only
 * need to convey the ratio correctly.
 */
export function resolveImageDimensions(
  aspect: string,
  projectWidth: number,
  projectHeight: number,
): { width: number; height: number } {
  const opt = ASPECT_RATIO_OPTIONS.find((o) => o.value === aspect)
  if (!opt || !opt.dim) {
    return {
      width: projectWidth > 0 ? projectWidth : 1024,
      height: projectHeight > 0 ? projectHeight : 1024,
    }
  }
  const ratio = opt.dim.w / opt.dim.h
  const baseSize = Math.max(projectWidth, projectHeight, 1024)
  return ratio >= 1
    ? { width: baseSize, height: Math.round(baseSize / ratio) }
    : { width: Math.round(baseSize * ratio), height: baseSize }
}
