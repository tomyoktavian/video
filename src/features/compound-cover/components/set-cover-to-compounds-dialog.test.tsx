import type { ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

type TestImageSource =
  | {
      kind: 'media-library'
      mediaId: string
      src: string
      width: number
      height: number
    }
  | {
      kind: 'unsaved-blob'
      file: File
      objectUrl: string
      width: number
      height: number
      tags?: readonly string[]
      promptSnippet?: string
    }

const dialogStoreState = vi.hoisted(() => ({
  isOpen: true,
  source: {
    kind: 'media-library',
    mediaId: 'media-1',
    src: 'https://example.test/img.png',
    width: 1920,
    height: 1080,
  } as TestImageSource,
  open: vi.fn(),
  close: vi.fn(),
}))

const compositionsState = vi.hoisted(() => ({
  compositions: [
    {
      id: 'comp-a',
      name: 'Episode A',
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 300,
    },
    {
      id: 'comp-b',
      name: 'Episode B',
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 600,
    },
    {
      id: 'comp-c',
      name: 'Bonus Reel',
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 150,
    },
  ],
}))

const mediaLibraryState = vi.hoisted(() => ({
  showNotification: vi.fn(),
  currentProjectId: 'project-1',
}))

const insertCoverMock = vi.hoisted(() => vi.fn())
const importGeneratedImageMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'media-new', src: '', width: 1024, height: 1024 })),
)
const resolveMediaUrlMock = vi.hoisted(() => vi.fn(async (id: string) => `resolved://${id}`))

vi.mock('@/shared/state/set-cover-to-compounds-dialog', () => ({
  useSetCoverToCompoundsDialogStore: Object.assign(
    (selector: (state: typeof dialogStoreState) => unknown) => selector(dialogStoreState),
    { getState: () => dialogStoreState },
  ),
}))

vi.mock('../deps/timeline', () => ({
  useCompositionsStore: (selector: (state: typeof compositionsState) => unknown) =>
    selector(compositionsState),
  useMediaLibraryStore: (selector: (state: typeof mediaLibraryState) => unknown) =>
    selector(mediaLibraryState),
  mediaLibraryService: {
    importGeneratedImage: importGeneratedImageMock,
  },
  resolveMediaUrl: resolveMediaUrlMock,
}))

vi.mock('../insert-cover-action', () => ({
  insertCover: insertCoverMock,
}))

vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('@/components/ui/label', () => ({
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/slider', () => ({
  Slider: ({
    value,
    onValueChange,
    min,
    max,
    step,
    'aria-label': ariaLabel,
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    min: number
    max: number
    step: number
    'aria-label'?: string
  }) => (
    <input
      type="range"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value[0] ?? 0}
      onChange={(event) => onValueChange([Number(event.target.value)])}
    />
  ),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('lucide-react', () => ({
  Loader2: () => <span aria-hidden="true">loader</span>,
  Search: () => <span aria-hidden="true">search</span>,
}))

import { SetCoverToCompoundsDialog } from './set-cover-to-compounds-dialog'

function resetState() {
  dialogStoreState.isOpen = true
  dialogStoreState.source = {
    kind: 'media-library',
    mediaId: 'media-1',
    src: 'https://example.test/img.png',
    width: 1920,
    height: 1080,
  }
  dialogStoreState.close.mockReset()
  mediaLibraryState.showNotification.mockReset()
  insertCoverMock.mockReset()
  importGeneratedImageMock.mockReset()
  importGeneratedImageMock.mockResolvedValue({
    id: 'media-new',
    src: '',
    width: 1024,
    height: 1024,
  })
  resolveMediaUrlMock.mockReset()
  resolveMediaUrlMock.mockImplementation(async (id: string) => `resolved://${id}`)
}

function clickCheckbox(label: string) {
  const checkbox = within(screen.getByText(label).closest('label')!).getByRole('checkbox')
  fireEvent.click(checkbox)
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SetCoverToCompoundsDialog', () => {
  beforeEach(() => {
    resetState()
  })

  it('lists all compounds and filters by name', () => {
    render(<SetCoverToCompoundsDialog />)

    expect(screen.getByText('Episode A')).toBeInTheDocument()
    expect(screen.getByText('Episode B')).toBeInTheDocument()
    expect(screen.getByText('Bonus Reel')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search compounds…'), {
      target: { value: 'episode' },
    })

    expect(screen.getByText('Episode A')).toBeInTheDocument()
    expect(screen.getByText('Episode B')).toBeInTheDocument()
    expect(screen.queryByText('Bonus Reel')).not.toBeInTheDocument()
  })

  it('selects all visible compounds when "Select all" is toggled', () => {
    render(<SetCoverToCompoundsDialog />)

    fireEvent.change(screen.getByPlaceholderText('Search compounds…'), {
      target: { value: 'episode' },
    })

    const selectAll = screen.getByLabelText('Select all visible compounds')
    fireEvent.click(selectAll)

    expect(screen.getByText('Set cover (2)')).toBeInTheDocument()
  })

  it('calls insertCover once per selected compound on submit (media-library source)', async () => {
    render(<SetCoverToCompoundsDialog />)

    clickCheckbox('Episode A')
    clickCheckbox('Bonus Reel')

    fireEvent.click(screen.getByText('Set cover (2)'))
    await flushPromises()

    expect(importGeneratedImageMock).not.toHaveBeenCalled()
    expect(insertCoverMock).toHaveBeenCalledTimes(2)
    expect(insertCoverMock).toHaveBeenNthCalledWith(1, {
      compositionId: 'comp-a',
      durationSec: 0.5,
      frameMediaId: 'media-1',
      frameSrc: 'https://example.test/img.png',
      frameWidth: 1920,
      frameHeight: 1080,
      primary: '',
    })
    expect(insertCoverMock).toHaveBeenNthCalledWith(2, {
      compositionId: 'comp-c',
      durationSec: 0.5,
      frameMediaId: 'media-1',
      frameSrc: 'https://example.test/img.png',
      frameWidth: 1920,
      frameHeight: 1080,
      primary: '',
    })
    expect(mediaLibraryState.showNotification).toHaveBeenCalledWith({
      type: 'success',
      message: 'Cover added to 2/2 compounds',
    })
    expect(dialogStoreState.close).toHaveBeenCalledTimes(1)
  })

  it('saves the blob to the media library before inserting (unsaved-blob source)', async () => {
    dialogStoreState.source = {
      kind: 'unsaved-blob',
      file: new File([new Uint8Array([1, 2, 3])], 'gen.png', { type: 'image/png' }),
      objectUrl: 'blob:test',
      width: 1024,
      height: 1024,
      tags: ['ai-generated'],
      promptSnippet: 'a poster',
    }

    render(<SetCoverToCompoundsDialog />)
    clickCheckbox('Episode A')
    fireEvent.click(screen.getByText('Set cover (1)'))
    await flushPromises()
    await flushPromises()

    expect(importGeneratedImageMock).toHaveBeenCalledTimes(1)
    expect(resolveMediaUrlMock).toHaveBeenCalledWith('media-new')
    expect(insertCoverMock).toHaveBeenCalledTimes(1)
    expect(insertCoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        compositionId: 'comp-a',
        frameMediaId: 'media-new',
        frameSrc: 'resolved://media-new',
      }),
    )
  })

  it('reports partial failures', async () => {
    insertCoverMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    insertCoverMock.mockImplementationOnce(() => undefined)

    render(<SetCoverToCompoundsDialog />)
    clickCheckbox('Episode A')
    clickCheckbox('Episode B')
    fireEvent.click(screen.getByText('Set cover (2)'))
    await flushPromises()

    expect(insertCoverMock).toHaveBeenCalledTimes(2)
    expect(mediaLibraryState.showNotification).toHaveBeenCalledWith({
      type: 'warning',
      message: 'Cover added to 1/2 compounds, 1 failed',
    })
  })
})
