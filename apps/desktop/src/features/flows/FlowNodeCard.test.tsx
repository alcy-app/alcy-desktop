import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../test-utils'
import { act, fireEvent } from '@testing-library/react'
import { FlowNodeCard } from './FlowNodeCard'
import { TOOLTIP_DELAY_MS } from '../../shared/ui/use-tooltip'

function renderCard(ui: ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

describe('FlowNodeCard', () => {
  it('shows the default kind title and description', () => {
    renderCard(<FlowNodeCard kind="if" />)

    expect(screen.getByText('Condicional')).toBeInTheDocument()
    expect(screen.getByText('If · segue um caminho conforme a condição')).toBeInTheDocument()
  })

  it('renders one row and terminal per named output', () => {
    const { container } = renderCard(
      <FlowNodeCard
        kind="while"
        outputs={[
          { id: 'loop', label: 'Loop', variant: 'loop' },
          { id: 'done', label: 'Fim', variant: 'neutral' },
        ]}
      />,
    )

    expect(screen.getByText('Loop')).toBeInTheDocument()
    expect(screen.getByText('Fim')).toBeInTheDocument()
    const sourceIds = [...container.querySelectorAll('.react-flow__handle.source')].map((handle) => handle.getAttribute('data-handleid'))
    expect(sourceIds).toEqual(['loop', 'done'])
    expect(container.querySelectorAll('.react-flow__handle.target')).toHaveLength(1)
  })

  it('omits terminals when requested', () => {
    const { container } = renderCard(<FlowNodeCard kind="start" hasInput={false} outputs="none" />)

    expect(container.querySelectorAll('.react-flow__handle')).toHaveLength(0)
  })

  it('shows failure in the existing summary row', () => {
    renderCard(<FlowNodeCard kind="log" runStatus={{ status: 'failed', message: 'variável ausente' }} />)

    expect(screen.getByText('Falhou')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('variável ausente')
  })

  it('opens the inspector from the title and node actions from the menu', () => {
    const onOpenSettings = vi.fn()
    const onDuplicate = vi.fn()
    renderCard(<FlowNodeCard kind="sleep" onOpenSettings={onOpenSettings} onDuplicate={onDuplicate} onDelete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir configurações deste node' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Ações do bloco' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar este node' }))
    expect(onDuplicate).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('uses static hover hints and menus for node controls without removing their actions', () => {
    vi.useFakeTimers()
    try {
      const duplicate = vi.fn()
      renderCard(<FlowNodeCard kind="request" onDuplicate={duplicate} onDelete={vi.fn()} />)
      const trigger = screen.getByRole('button', { name: 'Ações do bloco' })
      fireEvent.mouseEnter(trigger)
      act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
      expect(screen.getByRole('tooltip')).toHaveClass('ui-tooltip--static')
      expect(screen.getByRole('tooltip').parentElement).toBe(document.body)
      fireEvent.pointerDown(trigger)
      fireEvent.click(trigger)
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      expect(screen.getByRole('menu')).toHaveClass('ui-menu--static')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar este node' }))
      expect(duplicate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides editing actions in read-only snapshots', () => {
    const onOpenSettings = vi.fn()
    const { rerender } = renderCard(
      <FlowNodeCard kind="sleep" onOpenSettings={onOpenSettings} onDuplicate={vi.fn()} onDelete={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Abrir configurações deste node' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ações do bloco' })).toBeInTheDocument()

    rerender(
      <ReactFlowProvider>
        <FlowNodeCard kind="sleep" readOnly onOpenSettings={onOpenSettings} onDuplicate={vi.fn()} onDelete={vi.fn()} />
      </ReactFlowProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Abrir configurações deste node' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ações do bloco' })).toBeNull()
  })
})
