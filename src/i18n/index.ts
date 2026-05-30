import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { createLogger } from '@/shared/logging/logger'
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, resolveSupportedLanguage } from './languages'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import de from './locales/de.json'
import ptBR from './locales/pt-BR.json'
import tr from './locales/tr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const log = createLogger('i18n')

export const I18N_STORAGE_KEY = 'freecut-language'

type LocaleTree = Record<string, unknown>

const baseLocales: Record<string, LocaleTree> = {
  en: en as LocaleTree,
  es: es as LocaleTree,
  fr: fr as LocaleTree,
  de: de as LocaleTree,
  'pt-BR': ptBR as LocaleTree,
  tr: tr as LocaleTree,
  ja: ja as LocaleTree,
  ko: ko as LocaleTree,
  zh: zh as LocaleTree,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      deepMerge(existing, value)
    } else {
      target[key] = value
    }
  }
}

/**
 * Per-feature translation partials. Each file is shaped
 * `{ "<lang>": { ...slice of the translation tree... } }` and is deep-merged
 * over the base locale data. This lets feature modules ship their own strings
 * without everyone editing one giant JSON file.
 */
const partialModules = import.meta.glob<{ default: Record<string, LocaleTree> }>(
  './locales/partials/*.json',
  { eager: true },
)

const mergedLocales: Record<string, LocaleTree> = {}
for (const lang of SUPPORTED_LANGUAGE_CODES) {
  mergedLocales[lang] = structuredClone(baseLocales[lang] ?? {})
}
function normalizePartialSlice(path: string, slice: LocaleTree): LocaleTree {
  if (path.endsWith('/effects.json') && !isPlainObject(slice.effects)) {
    return { effects: slice }
  }

  return slice
}

const orderedPartialModules = Object.entries(partialModules).sort(([leftPath], [rightPath]) =>
  leftPath.localeCompare(rightPath),
)

for (const [path, mod] of orderedPartialModules) {
  const partial = mod.default ?? {}
  for (const [lang, slice] of Object.entries(partial)) {
    if (!isPlainObject(slice)) continue
    const dest = mergedLocales[lang] ?? (mergedLocales[lang] = {})
    deepMerge(dest, normalizePartialSlice(path, slice))
  }
}

const resources = Object.fromEntries(
  Object.entries(mergedLocales).map(([lang, tree]) => [lang, { translation: tree }]),
)

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGE_CODES as string[],
    load: 'currentOnly',
    interpolation: {
      // React already escapes values to prevent XSS.
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: I18N_STORAGE_KEY,
      caches: ['localStorage'],
      convertDetectedLanguage: resolveSupportedLanguage,
    },
    returnEmptyString: false,
  })
  .catch((err) => {
    log.error('Failed to initialize i18n', err)
  })

function syncDocumentLanguage(lng: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = resolveSupportedLanguage(lng)
}

syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANGUAGE)
i18n.on('languageChanged', syncDocumentLanguage)

export { i18n }
export default i18n
