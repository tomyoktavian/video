// Helpers for the Supertonic 3 web worker — Unicode tokenizer, chunker,
// 16-bit PCM WAV writer, and voice style loader. Ported from
// supertone-inc/supertonic and the Supertonic 3 HF Space demo.

const HF_BASE_URL = 'https://huggingface.co/Supertone/supertonic-3/resolve/main'
const CACHE_NAME = 'transformers-cache'
const CJK_LANGS = new Set(['ko', 'ja', 'zh'])

function emojiRegex() {
  return /\p{Extended_Pictographic}/gu
}

function preprocessText(text, lang) {
  let processed = text.normalize('NFKD')
  processed = processed.replace(emojiRegex(), ' ')
  processed = processed.replace(/[—–]/g, ' - ')
  processed = processed.replace(/["“”]/g, '"').replace(/[‘’]/g, "'")
  processed = processed.replace(/\s+/g, ' ').trim()
  if (!/[.!?]$/.test(processed)) processed += '.'
  return lang ? `<${lang}>${processed}</${lang}>` : processed
}

function chunkText(text, lang) {
  const maxLen = CJK_LANGS.has(lang) ? 120 : 300
  if (text.length <= maxLen) return [text]

  const paragraphs = text.split(/\n{2,}/)
  const chunks = []
  let current = ''

  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }

  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [paragraph]
    for (const sentence of sentences) {
      const trimmed = sentence.trim()
      if (!trimmed) continue
      if (trimmed.length > maxLen) {
        flush()
        const words = trimmed.split(/\s+/)
        for (const word of words) {
          const candidate = current ? `${current} ${word}` : word
          if (candidate.length > maxLen) {
            flush()
            current = word
          } else {
            current = candidate
          }
        }
        flush()
        continue
      }
      const candidate = current ? `${current} ${trimmed}` : trimmed
      if (candidate.length > maxLen) {
        flush()
        current = trimmed
      } else {
        current = candidate
      }
    }
    flush()
  }

  return chunks.length > 0 ? chunks : [text]
}

async function fetchWithCache(url, onProgress) {
  if (typeof caches === 'undefined') {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`)
    }
    return response.arrayBuffer()
  }

  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(url)
  if (cached) {
    onProgress?.({ url, fromCache: true })
    return cached.arrayBuffer()
  }

  onProgress?.({ url, fromCache: false, stage: 'downloading' })
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  const clone = response.clone()
  try {
    await cache.put(url, clone)
  } catch (error) {
    // Ignore cache-put failures (quota, opaque responses, etc.) and use the response anyway.
    console.warn('Supertonic cache put failed', error)
  }
  onProgress?.({ url, fromCache: false, stage: 'cached' })
  return response.arrayBuffer()
}

async function fetchJson(url, onProgress) {
  const buffer = await fetchWithCache(url, onProgress)
  const text = new TextDecoder().decode(buffer)
  return JSON.parse(text)
}

export async function loadAsset(relativePath, { json = false } = {}, onProgress) {
  const url = `${HF_BASE_URL}/${relativePath.replace(/^\/+/, '')}`
  return json ? fetchJson(url, onProgress) : fetchWithCache(url, onProgress)
}

export class UnicodeProcessor {
  constructor(indexer) {
    this.indexer = indexer
    this.unkId = indexer['<unk>'] ?? 0
  }

  encode(text) {
    const ids = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      const key = cp !== undefined ? String(cp) : ''
      const id = this.indexer[key]
      ids.push(typeof id === 'number' ? id : this.unkId)
    }
    return ids
  }

  call(textList, lang) {
    const tokensPerText = textList.map((entry) => this.encode(preprocessText(entry, lang)))
    const maxLen = tokensPerText.reduce((max, ids) => Math.max(max, ids.length), 1)
    const batch = tokensPerText.length
    const textIds = new BigInt64Array(batch * maxLen)
    const textMask = new Float32Array(batch * maxLen)
    for (let row = 0; row < batch; row += 1) {
      const ids = tokensPerText[row]
      for (let col = 0; col < ids.length; col += 1) {
        textIds[row * maxLen + col] = BigInt(ids[col])
        textMask[row * maxLen + col] = 1
      }
    }
    return { textIds, textMask, batch, maxLen }
  }
}

export { chunkText, preprocessText }

// Build a 16-bit PCM mono WAV buffer from a Float32 signal.
export function writeWav16BitPcm(samples, sampleRate) {
  const numSamples = samples.length
  const blockAlign = 2 // 16-bit mono
  const dataSize = numSamples * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let index = 0; index < numSamples; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }

  return buffer
}

// Concatenate Float32 chunks with optional silence padding (in seconds).
export function concatFloat32WithSilence(chunks, sampleRate, silenceSeconds) {
  if (chunks.length === 0) return new Float32Array(0)
  const silenceSamples = Math.max(0, Math.floor(sampleRate * silenceSeconds))
  const silence = new Float32Array(silenceSamples)
  const total =
    chunks.reduce((sum, chunk) => sum + chunk.length, 0) + silenceSamples * (chunks.length - 1)
  const merged = new Float32Array(total)
  let offset = 0
  for (let index = 0; index < chunks.length; index += 1) {
    merged.set(chunks[index], offset)
    offset += chunks[index].length
    if (index < chunks.length - 1) {
      merged.set(silence, offset)
      offset += silenceSamples
    }
  }
  return merged
}

// Convert a voice style JSON into Float32Array tensors.
// Supertonic 3 voice files expose `{ style_ttl: { data, type, dims }, style_dp: { ... } }`.
// Some bundled exports omit `style_dp`; fall back to `style_ttl` so the
// duration predictor still gets a compatible style embedding.
export function loadVoiceStyleTensors(voiceJson) {
  const ttl = unwrapStyleEntry(voiceJson.style_ttl)
  const dp = unwrapStyleEntry(voiceJson.style_dp) ?? ttl
  if (!ttl) {
    throw new Error('Voice style JSON is missing required style_ttl field.')
  }
  return {
    styleTtl: Float32Array.from(ttl.data),
    styleDp: Float32Array.from(dp.data),
    styleTtlShape: ttl.dims,
    styleDpShape: dp.dims,
  }
}

function unwrapStyleEntry(value) {
  if (!value) return null
  if (Array.isArray(value)) {
    return { data: flattenNested(value), dims: shapeOf(value) }
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.data)) {
      const dims = Array.isArray(value.dims) ? value.dims : shapeOf(value.data)
      return { data: flattenNested(value.data), dims }
    }
  }
  return null
}

function flattenNested(value, out = []) {
  if (Array.isArray(value)) {
    for (const child of value) flattenNested(child, out)
  } else if (typeof value === 'number') {
    out.push(value)
  }
  return out
}

function shapeOf(value) {
  const shape = []
  let cursor = value
  while (Array.isArray(cursor)) {
    shape.push(cursor.length)
    cursor = cursor[0]
  }
  return shape
}
