import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('@/features/media-library/deps/settings-contract', () => ({
  getCustomAiCaptionMakerConfig: vi.fn(),
}))

vi.mock('./extract-audio', () => ({
  extractAudioForUpload: vi.fn(),
}))

import { getCustomAiCaptionMakerConfig } from '@/features/media-library/deps/settings-contract'
import {
  fetchCustomAiModels,
  openaiCompatibleTranscriptionAdapter,
} from './openai-compatible-adapter'
import { extractAudioForUpload } from './extract-audio'

const mockedConfig = vi.mocked(getCustomAiCaptionMakerConfig)
const mockedExtract = vi.mocked(extractAudioForUpload)
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  mockedConfig.mockReset()
  mockedExtract.mockReset()
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'audio.mp3', { type: 'audio/mp3' })
}

function makeVideoFile(byteLength = 100): File {
  return new File([new Uint8Array(byteLength)], 'clip.mp4', { type: 'video/mp4' })
}

describe('openaiCompatibleTranscriptionAdapter', () => {
  it('posts a multipart transcription request and parses verbose_json segments', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'hello world',
          segments: [
            { text: 'hello', start: 0, end: 0.5 },
            { text: 'world', start: 0.5, end: 1.1 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const stream = openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeFile(), { model: 'whisper-1', language: 'id' })

    const segments = await stream.collect()

    expect(segments).toEqual([
      { text: 'hello', start: 0, end: 0.5 },
      { text: 'world', start: 0.5, end: 1.1 },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/audio/transcriptions')
    expect(init?.method).toBe('POST')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')

    const form = init?.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('language')).toBe('id')
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment'])
    expect(form.get('file')).toBeInstanceOf(File)
  })

  it('groups a words-only response into pseudo-segments by sentence and gap', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          words: [
            { word: 'hi', start: 0, end: 0.4 },
            { word: 'there.', start: 0.4, end: 0.9 },
            // Long gap (> 0.6 s) forces a new segment.
            { word: 'how', start: 1.8, end: 2.0 },
            { word: 'are', start: 2.0, end: 2.2 },
            { word: 'you', start: 2.2, end: 2.5 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const segments = await openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeFile(), { model: 'whisper-1' })
      .collect()

    expect(segments).toEqual([
      {
        text: 'hi there.',
        start: 0,
        end: 0.9,
        words: [
          { text: 'hi', start: 0, end: 0.4 },
          { text: 'there.', start: 0.4, end: 0.9 },
        ],
      },
      {
        text: 'how are you',
        start: 1.8,
        end: 2.5,
        words: [
          { text: 'how', start: 1.8, end: 2.0 },
          { text: 'are', start: 2.0, end: 2.2 },
          { text: 'you', start: 2.2, end: 2.5 },
        ],
      },
    ])
  })

  it('attaches top-level word timestamps to their parent segments', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'hello world how are you',
          segments: [
            { text: 'hello world', start: 0, end: 1.0 },
            { text: 'how are you', start: 1.0, end: 2.5 },
          ],
          words: [
            { word: 'hello', start: 0.0, end: 0.4 },
            { word: 'world', start: 0.5, end: 1.0 },
            { word: 'how', start: 1.0, end: 1.3 },
            { word: 'are', start: 1.4, end: 1.6 },
            { word: 'you', start: 1.7, end: 2.4 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const segments = await openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeFile(), { model: 'whisper-1' })
      .collect()

    expect(segments[0]?.words).toEqual([
      { text: 'hello', start: 0.0, end: 0.4 },
      { text: 'world', start: 0.5, end: 1.0 },
    ])
    expect(segments[1]?.words).toEqual([
      { text: 'how', start: 1.0, end: 1.3 },
      { text: 'are', start: 1.4, end: 1.6 },
      { text: 'you', start: 1.7, end: 2.4 },
    ])
  })

  it('preserves inline segment.words when both segment and word arrays are returned', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          segments: [
            {
              text: 'hello world',
              start: 0,
              end: 1.0,
              words: [
                { word: 'hello', start: 0.0, end: 0.4 },
                { word: 'world', start: 0.5, end: 1.0 },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const segments = await openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeFile(), { model: 'whisper-1' })
      .collect()

    expect(segments).toEqual([
      {
        text: 'hello world',
        start: 0,
        end: 1.0,
        words: [
          { text: 'hello', start: 0.0, end: 0.4 },
          { text: 'world', start: 0.5, end: 1.0 },
        ],
      },
    ])
  })

  it('throws when base URL or API key is missing', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: '',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    const stream = openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeFile(), { model: 'whisper-1' })

    await expect(stream.collect()).rejects.toThrow(/base URL/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('extracts audio from a video source before uploading', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    const extractedBlob = new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'audio/mpeg' })
    mockedExtract.mockResolvedValue({
      blob: extractedBlob,
      fileName: 'clip.mp3',
      mimeType: 'audio/mpeg',
    })

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ segments: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeVideoFile(), { model: 'whisper-1' })
      .collect()

    expect(mockedExtract).toHaveBeenCalledTimes(1)
    const form = fetchMock.mock.calls[0]![1]?.body as FormData
    const uploaded = form.get('file') as File
    expect(uploaded.name).toBe('clip.mp3')
    expect(uploaded.size).toBe(extractedBlob.size)
  })

  it('skips extraction for small audio sources', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ segments: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeFile(), { model: 'whisper-1' })
      .collect()

    expect(mockedExtract).not.toHaveBeenCalled()
    const form = fetchMock.mock.calls[0]![1]?.body as FormData
    expect((form.get('file') as File).name).toBe('audio.mp3')
  })

  it('surfaces the HTTP body when the API returns a non-2xx response', async () => {
    mockedConfig.mockReturnValue({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: '',
      cachedModels: [],
      lastLoadedAt: null,
    })

    fetchMock.mockResolvedValue(new Response('Invalid API key', { status: 401 }))

    const stream = openaiCompatibleTranscriptionAdapter
      .createTranscriber()
      .transcribe(makeFile(), { model: 'whisper-1' })

    await expect(stream.collect()).rejects.toThrow(/401/)
  })
})

describe('fetchCustomAiModels', () => {
  it('returns a normalized id/label list', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'whisper-1', name: 'Whisper v1' },
            { id: 'gpt-4o-transcribe' },
            { id: '' }, // skipped
            { name: 'orphan' }, // skipped
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const models = await fetchCustomAiModels('https://api.example.com/v1', 'sk-test')

    expect(models).toEqual([{ id: 'whisper-1', label: 'Whisper v1' }, { id: 'gpt-4o-transcribe' }])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/models')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('throws when the response payload lacks a data array', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(fetchCustomAiModels('https://api.example.com', 'sk-test')).rejects.toThrow(/data/)
  })
})
