import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { AgentDockOverlay } from './AgentDockOverlay'
import { dockAt, dockPreviewRect, unionRect, useAgentDockDrag } from './use-agent-dock-drag'
import type { AgentDock } from './use-agent-preferences'

const REGION = { left: 100, top: 50, width: 800, height: 600 }

describe('dockAt', () => {
  it('picks the side of the region nearest to the pointer', () => {
    expect(dockAt({ x: 880, y: 300 }, REGION)).toBe('right')
    expect(dockAt({ x: 120, y: 300 }, REGION)).toBe('left')
    expect(dockAt({ x: 500, y: 630 }, REGION)).toBe('bottom')
  })
})

describe('dockPreviewRect', () => {
  it('places the panel along the chosen side, never larger than the region', () => {
    expect(dockPreviewRect('right', REGION, 380)).toEqual({ left: 520, top: 50, width: 380, height: 600 })
    expect(dockPreviewRect('left', REGION, 380)).toEqual({ left: 100, top: 50, width: 380, height: 600 })
    expect(dockPreviewRect('bottom', REGION, 320)).toEqual({ left: 100, top: 330, width: 800, height: 320 })
    expect(dockPreviewRect('bottom', REGION, 9_000).height).toBe(600)
  })
})

describe('unionRect', () => {
  it('spans the laid-out rects and leaves hidden ones out', () => {
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height })
    expect(unionRect([rect(0, 40, 300, 600), rect(300, 40, 500, 400), rect(0, 0, 0, 0), null])).toEqual({ left: 0, top: 40, width: 800, height: 600 })
    expect(unionRect([rect(0, 0, 0, 0)])).toBeNull()
  })
})

function DraggableHeader({ onDock }: { onDock: (dock: AgentDock) => void }) {
  const { preview, startDrag } = useAgentDockDrag({ measureRegion: () => REGION, previewRect: (dock) => dockPreviewRect(dock, REGION, 300), onDock })
  return (
    <>
      <header data-testid="header" onPointerDown={startDrag}>
        <span>Chat</span>
        <button type="button">New chat</button>
      </header>
      <AgentDockOverlay preview={preview} />
    </>
  )
}

describe('useAgentDockDrag', () => {
  it('previews the nearest side while dragging and docks there on release', () => {
    const onDock = vi.fn()
    const { container } = render(<DraggableHeader onDock={onDock} />)

    fireEvent.pointerDown(screen.getByText('Chat'), { button: 0, clientX: 850, clientY: 60 })
    fireEvent.pointerMove(window, { clientX: 130, clientY: 300 })
    const preview = container.ownerDocument.querySelector<HTMLElement>('.agent-dock-preview')
    expect(preview).toHaveAttribute('data-dock', 'left')
    expect(preview).toHaveTextContent('Esquerda')

    fireEvent.pointerMove(window, { clientX: 500, clientY: 640 })
    expect(container.ownerDocument.querySelector('.agent-dock-preview')).toHaveAttribute('data-dock', 'bottom')

    fireEvent.pointerUp(window)
    expect(onDock).toHaveBeenCalledExactlyOnceWith('bottom')
    expect(container.ownerDocument.querySelector('.agent-dock-preview')).not.toBeInTheDocument()
  })

  it('treats a press without movement as a click', () => {
    const onDock = vi.fn()
    render(<DraggableHeader onDock={onDock} />)

    fireEvent.pointerDown(screen.getByText('Chat'), { button: 0, clientX: 850, clientY: 60 })
    fireEvent.pointerMove(window, { clientX: 852, clientY: 61 })
    fireEvent.pointerUp(window)

    expect(onDock).not.toHaveBeenCalled()
  })

  it('cancels with Escape', () => {
    const onDock = vi.fn()
    const { container } = render(<DraggableHeader onDock={onDock} />)

    fireEvent.pointerDown(screen.getByText('Chat'), { button: 0, clientX: 850, clientY: 60 })
    fireEvent.pointerMove(window, { clientX: 130, clientY: 300 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window)

    expect(onDock).not.toHaveBeenCalled()
    expect(container.ownerDocument.querySelector('.agent-dock-preview')).not.toBeInTheDocument()
  })

  it('leaves the header buttons alone', () => {
    const onDock = vi.fn()
    render(<DraggableHeader onDock={onDock} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New chat' }), { button: 0, clientX: 850, clientY: 60 })
    fireEvent.pointerMove(window, { clientX: 130, clientY: 300 })
    fireEvent.pointerUp(window)

    expect(onDock).not.toHaveBeenCalled()
  })
})
