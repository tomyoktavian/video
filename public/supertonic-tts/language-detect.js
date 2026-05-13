// Lightweight language detector ported from the Supertonic 3 HF Space demo.
// Returns an ISO 639-1 code (e.g. "en", "id", "ja") or "en" as a safe default.

const NON_LATIN_RANGES = [
  { lang: 'ko', test: (cp) => (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) },
  { lang: 'ja', test: (cp) => (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) },
  { lang: 'ar', test: (cp) => (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) },
  { lang: 'hi', test: (cp) => cp >= 0x0900 && cp <= 0x097f },
  { lang: 'el', test: (cp) => cp >= 0x0370 && cp <= 0x03ff },
  { lang: 'cyrillic', test: (cp) => cp >= 0x0400 && cp <= 0x04ff },
]

const LATIN_HINTS = {
  en: { chars: /[a-z]/i, stopwords: ['the', 'and', 'is', 'in', 'of', 'to', 'a', 'for', 'with'] },
  id: {
    chars: /[a-z]/i,
    stopwords: ['yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'tidak'],
  },
  es: {
    chars: /[ñáéíóúü¿¡]/i,
    stopwords: ['el', 'la', 'que', 'de', 'y', 'en', 'los', 'para', 'con', 'una'],
  },
  fr: {
    chars: /[àâçéèêëîïôûùüÿœ]/i,
    stopwords: ['le', 'la', 'de', 'et', 'à', 'les', 'des', 'pour', 'que', 'une'],
  },
  de: {
    chars: /[äöüß]/i,
    stopwords: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'für', 'mit', 'ein', 'auf'],
  },
  it: {
    chars: /[àèéìòù]/i,
    stopwords: ['il', 'la', 'di', 'che', 'e', 'per', 'un', 'una', 'con', 'sono'],
  },
  pt: {
    chars: /[ãõçáâéêíóôú]/i,
    stopwords: ['o', 'a', 'de', 'que', 'e', 'para', 'com', 'não', 'uma', 'são'],
  },
  nl: { chars: /[ëï]/i, stopwords: ['de', 'het', 'een', 'en', 'van', 'op', 'voor', 'niet', 'is'] },
  pl: {
    chars: /[ąćęłńóśźż]/i,
    stopwords: ['i', 'w', 'na', 'z', 'jest', 'nie', 'do', 'się', 'że', 'to'],
  },
  cs: {
    chars: /[áčďéěíňóřšťúůýž]/i,
    stopwords: ['je', 'a', 'na', 'se', 'v', 'že', 'to', 'pro', 'ne', 'jak'],
  },
  sk: { chars: /[áäčďéíĺľňóôŕšťúýž]/i, stopwords: ['je', 'a', 'na', 'sa', 'v', 'že', 'to', 'pre'] },
  hu: {
    chars: /[áéíóöőúüű]/i,
    stopwords: ['a', 'az', 'és', 'hogy', 'nem', 'meg', 'is', 'de', 'ezt'],
  },
  ro: {
    chars: /[ăâîșț]/i,
    stopwords: ['și', 'de', 'la', 'cu', 'pe', 'ce', 'nu', 'pentru', 'este', 'sau'],
  },
  tr: {
    chars: /[çğıöşü]/i,
    stopwords: ['bir', 've', 'bu', 'için', 'ile', 'da', 'de', 'ne', 'çok'],
  },
  vi: {
    chars: /[ăâđêôơưàáảãạèéẻẽẹìíỉĩị]/i,
    stopwords: ['và', 'của', 'là', 'có', 'không', 'được', 'cho', 'người', 'này'],
  },
  fi: { chars: /[äö]/i, stopwords: ['ja', 'on', 'että', 'se', 'ei', 'minä', 'oli'] },
  sv: { chars: /[åäö]/i, stopwords: ['och', 'är', 'att', 'det', 'en', 'som', 'för'] },
  da: { chars: /[æøå]/i, stopwords: ['og', 'er', 'at', 'det', 'en', 'som', 'for', 'ikke'] },
  hr: { chars: /[čćđšž]/i, stopwords: ['i', 'je', 'na', 'se', 'u', 'da', 'za', 'koji'] },
  sl: { chars: /[čšž]/i, stopwords: ['in', 'je', 'na', 'se', 'da', 'za', 'ki', 'ne'] },
  lt: {
    chars: /[ąčęėįšųūž]/i,
    stopwords: ['ir', 'yra', 'kad', 'į', 'iš', 'ne', 'tai', 'su', 'kaip'],
  },
  lv: { chars: /[āčēģīķļņšūž]/i, stopwords: ['un', 'ir', 'kas', 'no', 'par', 'ka', 'tas'] },
  et: { chars: /[äöõü]/i, stopwords: ['ja', 'on', 'et', 'see', 'ei', 'ka', 'kui'] },
  bg: { chars: /./, stopwords: ['и', 'на', 'е', 'с', 'за', 'от', 'че', 'се', 'да'] },
  ru: { chars: /./, stopwords: ['и', 'в', 'не', 'на', 'я', 'что', 'он', 'с', 'как'] },
  uk: { chars: /./, stopwords: ['і', 'в', 'не', 'на', 'я', 'що', 'він', 'з', 'як'] },
}

function detectCyrillic(text) {
  const lower = text.toLowerCase()
  const scores = { ru: 0, uk: 0, bg: 0 }
  for (const stopword of LATIN_HINTS.ru.stopwords) {
    if (lower.includes(` ${stopword} `)) scores.ru += 1
  }
  for (const stopword of LATIN_HINTS.uk.stopwords) {
    if (lower.includes(` ${stopword} `)) scores.uk += 1
  }
  for (const stopword of LATIN_HINTS.bg.stopwords) {
    if (lower.includes(` ${stopword} `)) scores.bg += 1
  }
  if (/[ї|є|ґ|і]/i.test(text)) scores.uk += 3
  if (/[щъ]/i.test(text)) scores.bg += 2
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
  return best && best[1] > 0 ? best[0] : 'ru'
}

export function detectLanguage(text) {
  if (!text || text.length === 0) return 'en'

  for (const range of NON_LATIN_RANGES) {
    for (let index = 0; index < text.length; index += 1) {
      const cp = text.codePointAt(index)
      if (cp === undefined) continue
      if (range.test(cp)) {
        if (range.lang === 'cyrillic') return detectCyrillic(text)
        return range.lang
      }
    }
  }

  const lower = ` ${text.toLowerCase()} `
  const scores = {}
  for (const [lang, hint] of Object.entries(LATIN_HINTS)) {
    if (['ru', 'uk', 'bg'].includes(lang)) continue
    let score = 0
    if (hint.chars && hint.chars.test(text)) score += 1
    for (const stopword of hint.stopwords) {
      if (lower.includes(` ${stopword} `)) score += 2
    }
    scores[lang] = score
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  if (!sorted.length || sorted[0][1] < 2) return 'en'
  return sorted[0][0]
}
