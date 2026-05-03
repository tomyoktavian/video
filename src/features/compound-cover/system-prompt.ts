/**
 * Default system prompt for the Add Cover feature.
 *
 * Sent to the Custom AI `/chat/completions` endpoint to generate Vlog-style
 * title text suggestions (primary / accent / secondary) for a compound clip.
 * Users can override this via Settings → AI → Custom AI → Vision Analyzer →
 * "Cover Text Prompt".
 *
 * The user message (transcript blob OR free-form context) is appended by the
 * adapter — keep instructions about *role*, *output schema*, and *editorial
 * taste* here.
 */
export const DEFAULT_COVER_FINDER_SYSTEM_PROMPT = [
  'You write thumbnail / cover-card copy for short-form video (YouTube, TikTok,',
  'Reels). Your output renders on a Vlog-style template: a single bold all-caps',
  'title with one or two coloured "accent" words and a supporting line.',
  '',
  '## Input',
  '',
  'You receive ONE of the following in the user message:',
  '',
  '- **Transcript** — a concatenated transcript from a single video. Read it to',
  '  understand the topic, emotional hook, and the language of the speaker.',
  '- **Manual context** — a short free-form sentence the user typed (e.g.',
  '  "wedding Sari & Andi", "podcast tentang produktivitas"). Use it as the',
  '  brief.',
  '',
  '## Output schema (JSON only — no prose, no markdown fences)',
  '',
  '{',
  '  "titles": [',
  '    {',
  '      "primary":   "string, 1-4 words, the main hook (e.g. \\"TEKNIK\\")",',
  '      "accent":    "string, 1-3 words, the coloured-highlight phrase (e.g. \\"JAGO NGOMONG\\")",',
  '      "secondary": "string, 0-7 words, the supporting line (e.g. \\"YANG BISA MENGUBAH HIDUP KAMU\\")"',
  '    }',
  '    // up to 3 suggestions; first is the recommended pick',
  '  ]',
  '}',
  '',
  '## Editorial taste',
  '',
  '- Match the language of the input. If the transcript or context is in',
  '  Indonesian, write Indonesian. If English, write English. Never translate.',
  '- Punchy verbs and concrete nouns beat vague adjectives.',
  '- Prefer emotional hooks (curiosity, surprise, value) over clickbait',
  '  ("YOU WON\'T BELIEVE…", "INSANE!!"). The goal is to summarise, not lie.',
  '- The three slots together should read as ONE sentence or hook, e.g.',
  '  "[primary] [accent] [secondary]" → "TEKNIK JAGO NGOMONG YANG BISA',
  '  MENGUBAH HIDUP KAMU".',
  '- Keep `primary` short — it carries the most weight visually.',
  '- `accent` is what gets coloured; pick the most charged 1-3 words of the',
  '  hook (the verb phrase, the differentiator, the surprising claim).',
  '- `secondary` is optional. Omit (set "") when a 2-line cover already reads',
  '  cleanly.',
  '',
  '## Constraints',
  '',
  '- Return between 1 and 3 suggestions.',
  '- Each suggestion MUST have `primary` (non-empty). `accent` and `secondary`',
  '  may be empty strings.',
  '- Output ONLY the JSON object — no commentary, no markdown.',
].join('\n')

/**
 * Default template for the Add Cover → Generate with AI image prompt.
 *
 * This is fed DIRECTLY into the Image Generator's `/images/generations` as
 * the `prompt` field — there is no chat-completions step in between. The
 * three placeholders (`{title}`, `{transcript}`, `{aspect}`) are substituted
 * at build time by {@link buildPosterImagePrompt}.
 *
 * Users can override this template via Settings → AI → Custom AI → Vision
 * Analyzer → "Poster Prompt" — overrides should keep the same placeholders
 * so the substitution still works.
 */
export const DEFAULT_POSTER_PROMPT_SYSTEM_PROMPT = [
  'Title: {title}',
  'Transcript: {transcript}',
  '',
  'create a realistic movie poster from the title and transcript above.',
  '{aspect}',
  '{cast}',
  '{style}',
  '{mood}',
  '',
  '## Editorial taste',
  '- Match the tone of the source. Action / drama → bold and stormy.',
  '  Comedy → bright and playful. Documentary → muted portrait.',
  '- No real celebrity faces, no copyrighted characters, no brand logos.',
  '- Prefer concrete nouns and lighting details over vague adjectives.',
  '- Style must be photorealistic — no cartoon, no anime, no manga, no',
  '  illustration, no Pixar / 3D animation, no painterly look, no',
  '  cel-shading, no flat vector, no comic-book look, no stylised art.',
  '  Faces must look like real human faces, not drawn.',
  '- No director credits, no production company, no studio logo, no',
  '  release date, no IN CINEMAS line, no festival laurels, no rating',
  '  box, no hashtags, no footer credit strip.',
].join('\n')

/**
 * Curated options for the "target country / cast" dropdown in the Add Cover
 * AI form. Each option's `directive` is the string spliced into the prompt's
 * `{cast}` placeholder; `'auto'` resolves to an empty directive so the image
 * model is left to infer cast from the transcript itself.
 */
export const POSTER_CAST_OPTIONS = [
  { value: 'auto', label: 'Auto (infer from transcript)', directive: '' },
  {
    value: 'indonesian',
    label: 'Indonesian / Southeast Asian',
    directive:
      'Cast: Indonesian / Southeast Asian characters with Indonesian features and clothing.',
  },
  {
    value: 'east-asian',
    label: 'East Asian (Chinese / Japanese / Korean)',
    directive: 'Cast: East Asian characters (Chinese / Japanese / Korean features and styling).',
  },
  {
    value: 'south-asian',
    label: 'South Asian (Indian / Pakistani / Bangladeshi)',
    directive:
      'Cast: South Asian characters (Indian / Pakistani / Bangladeshi features and styling).',
  },
  {
    value: 'western',
    label: 'Western / Caucasian',
    directive: 'Cast: Western / Caucasian characters with Northern European or American features.',
  },
  {
    value: 'african',
    label: 'African / Black',
    directive: 'Cast: African / Black characters with authentic features and styling.',
  },
  {
    value: 'latino',
    label: 'Latino / Hispanic',
    directive: 'Cast: Latino / Hispanic characters with authentic features and styling.',
  },
  {
    value: 'middle-eastern',
    label: 'Middle Eastern / North African',
    directive:
      'Cast: Middle Eastern / North African characters with authentic features and styling.',
  },
  {
    value: 'mixed',
    label: 'Mixed / diverse cast',
    directive: 'Cast: a visibly diverse, multi-ethnic ensemble.',
  },
] as const

export type PosterCastValue = (typeof POSTER_CAST_OPTIONS)[number]['value']

/** Curated visual-style presets for the AI form. */
export const POSTER_STYLE_OPTIONS = [
  { value: 'auto', label: 'Auto (let the model decide)', directive: '' },
  {
    value: 'photoreal',
    label: 'Photorealistic',
    directive:
      'Visual style: photorealistic digital photography, sharp detail, natural skin texture.',
  },
  {
    value: 'cinematic-still',
    label: 'Cinematic film still',
    directive:
      'Visual style: cinematic film still, anamorphic lens, shallow depth of field, filmic colour grading.',
  },
  {
    value: 'editorial-photo',
    label: 'Editorial photo',
    directive:
      'Visual style: editorial-magazine portrait photography, clean studio lighting, premium look.',
  },
  {
    value: 'dramatic-keyart',
    label: 'Dramatic key art',
    directive:
      'Visual style: prestige TV key art, dramatic rim lighting, layered composition, painterly photoreal blend.',
  },
] as const

export type PosterStyleValue = (typeof POSTER_STYLE_OPTIONS)[number]['value']

/** Mood / genre presets that bias the lighting + colour palette. */
export const POSTER_MOOD_OPTIONS = [
  { value: 'auto', label: 'Auto (infer from transcript)', directive: '' },
  {
    value: 'drama',
    label: 'Drama',
    directive: 'Mood: emotional drama, soft directional lighting, muted palette with warm accents.',
  },
  {
    value: 'action',
    label: 'Action',
    directive: 'Mood: action thriller, bold contrast, dramatic rim light, stormy atmosphere.',
  },
  {
    value: 'thriller',
    label: 'Thriller / mystery',
    directive: 'Mood: tense thriller, low-key lighting, deep shadows, cool palette.',
  },
  {
    value: 'comedy',
    label: 'Comedy',
    directive: 'Mood: bright and playful, high-key lighting, saturated palette, clean look.',
  },
  {
    value: 'horror',
    label: 'Horror',
    directive:
      'Mood: horror, ominous low-key lighting, desaturated palette, unsettling atmosphere.',
  },
  {
    value: 'documentary',
    label: 'Documentary',
    directive:
      'Mood: documentary realism, natural ambient lighting, muted palette, candid composition.',
  },
] as const

export type PosterMoodValue = (typeof POSTER_MOOD_OPTIONS)[number]['value']

/**
 * UI options for the image-quality dropdown. Maps 1:1 to OpenAI's `quality`
 * field on `gpt-image-1` (`low | medium | high | auto`). Most other
 * providers (Gemini, Grok, Stability proxies) silently ignore the field.
 */
export const POSTER_QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto (provider default)' },
  { value: 'low', label: 'Low — faster / cheaper' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const

export type PosterQualityValue = (typeof POSTER_QUALITY_OPTIONS)[number]['value']

/**
 * Resolve the UI quality value to the on-the-wire `quality` field. Returns
 * `undefined` for `'auto'` so the adapter can omit the field entirely —
 * providers that don't recognise `quality: 'auto'` would otherwise error.
 */
export function resolvePosterQualityApiValue(
  value: PosterQualityValue,
): 'low' | 'medium' | 'high' | undefined {
  if (value === 'auto') return undefined
  return value
}

function resolveDirective<T extends { value: string; directive: string }>(
  options: ReadonlyArray<T>,
  value: string,
): string {
  return options.find((opt) => opt.value === value)?.directive ?? ''
}

export interface BuildPosterImagePromptParams {
  title: string
  transcript: string
  /** Aspect-ratio label like "16:9", "9:16", "1:1" — auto-derived from the canvas. */
  aspectLabel: string
  /** One of {@link POSTER_CAST_OPTIONS}. Defaults to `'auto'`. */
  cast?: PosterCastValue
  /** One of {@link POSTER_STYLE_OPTIONS}. Defaults to `'photoreal'`. */
  style?: PosterStyleValue
  /** One of {@link POSTER_MOOD_OPTIONS}. Defaults to `'auto'`. */
  mood?: PosterMoodValue
  /** Free-form additional instructions appended to the cast/style block. */
  customNotes?: string
  /**
   * Optional template override (from Settings → Vision Analyzer → Poster
   * Prompt). Should keep the `{title}`, `{transcript}`, `{aspect}`,
   * `{cast}`, `{style}`, `{mood}` placeholders; if any are missing they
   * simply won't be substituted.
   */
  templateOverride?: string
}

/**
 * Substitute the `{title}`, `{transcript}`, `{aspect}`, `{cast}`, `{style}`,
 * `{mood}` placeholders into the poster-prompt template (or the user's
 * Settings override) and return the resulting string. The output is fed
 * straight into the Image Generator's `/images/generations` endpoint as
 * the `prompt` field.
 *
 * Empty directives (e.g. `cast: 'auto'`) leave the line blank instead of
 * dumping a literal "Cast:" header — that keeps the resulting prompt clean
 * when the user doesn't want to constrain a particular axis.
 */
export function buildPosterImagePrompt({
  title,
  transcript,
  aspectLabel,
  cast = 'auto',
  style = 'photoreal',
  mood = 'auto',
  customNotes,
  templateOverride,
}: BuildPosterImagePromptParams): string {
  const castDirective = resolveDirective(POSTER_CAST_OPTIONS, cast)
  const styleDirective = resolveDirective(POSTER_STYLE_OPTIONS, style)
  const moodDirective = resolveDirective(POSTER_MOOD_OPTIONS, mood)
  const trimmedCustomNotes = customNotes?.trim() ?? ''
  // Splice any free-form notes onto the mood line so they ride alongside
  // the other directives without needing another placeholder.
  const moodWithNotes =
    trimmedCustomNotes.length > 0
      ? [moodDirective, trimmedCustomNotes].filter((part) => part.length > 0).join(' ')
      : moodDirective

  const template =
    templateOverride && templateOverride.trim().length > 0
      ? templateOverride
      : DEFAULT_POSTER_PROMPT_SYSTEM_PROMPT
  // `{aspect}` is its own line in the template, so substitute with either a
  // full sentence (when the user picked a specific ratio) or an empty string
  // (when "None" / auto). The post-processing pass below collapses the
  // resulting blank lines so the final prompt stays clean.
  const aspectDirective =
    aspectLabel.trim().length > 0 ? `Composed for a ${aspectLabel.trim()} aspect ratio.` : ''
  return template
    .replaceAll('{title}', title)
    .replaceAll('{transcript}', transcript)
    .replaceAll('{aspect}', aspectDirective)
    .replaceAll('{cast}', castDirective)
    .replaceAll('{style}', styleDirective)
    .replaceAll('{mood}', moodWithNotes)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n/gm, '\n')
    .trim()
}

export interface BuildFreeformImagePromptParams {
  /** User-typed prompt — appears verbatim at the top of the final string. */
  prompt: string
  /** Aspect-ratio label like "16:9". Empty string disables the aspect line. */
  aspectLabel?: string
  cast?: PosterCastValue
  style?: PosterStyleValue
  mood?: PosterMoodValue
  /** Free-form additional notes appended after the directives. */
  customNotes?: string
}

/**
 * Build a free-form image-generation prompt from a user-typed prompt plus the
 * cast / style / mood / aspect directives. Used by the AI sidebar's Image
 * Generation section, where there is no compound clip context — the user's
 * own prompt body replaces the title + transcript scaffold that
 * {@link buildPosterImagePrompt} uses.
 */
export function buildFreeformImagePrompt({
  prompt,
  aspectLabel = '',
  cast = 'auto',
  style = 'photoreal',
  mood = 'auto',
  customNotes,
}: BuildFreeformImagePromptParams): string {
  const trimmedPrompt = prompt.trim()
  if (trimmedPrompt.length === 0) {
    throw new Error('Image prompt is empty.')
  }

  const aspectDirective =
    aspectLabel.trim().length > 0 ? `Composed for a ${aspectLabel.trim()} aspect ratio.` : ''
  const castDirective = resolveDirective(POSTER_CAST_OPTIONS, cast)
  const styleDirective = resolveDirective(POSTER_STYLE_OPTIONS, style)
  const moodDirective = resolveDirective(POSTER_MOOD_OPTIONS, mood)
  const trimmedNotes = customNotes?.trim() ?? ''

  const directives = [aspectDirective, castDirective, styleDirective, moodDirective].filter(
    (d) => d.length > 0,
  )

  const parts: string[] = [trimmedPrompt]
  if (directives.length > 0) {
    parts.push('', ...directives)
  }
  if (trimmedNotes.length > 0) {
    parts.push('', trimmedNotes)
  }
  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
