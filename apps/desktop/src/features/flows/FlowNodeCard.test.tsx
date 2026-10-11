import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../test-utils'
import { FlowNodeCard } from './FlowNodeCard'

function renderCard(ui: ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

describe('FlowNodeCard', () => {
  it('mostra título e descrição do tipo por padrão', () => {
    renderCard(<FlowNodeCard kind="if" />)

    expect(screen.getByText('Condicional')).toBeInTheDocument()
    expect(screen.getByText('If · segue um caminho conforme a condição')).toBeInTheDocument()
  })

  it('renderiza uma linha e um handle por saída nomeada', () => {
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

  it('não tem saída nem entrada quando pedido', () => {
    const { container } = renderCard(<FlowNodeCard kind="start" hasInput={false} outputs="none" />)

    expect(container.querySelectorAll('.react-flow__handle')).toHaveLength(0)
  })

  it('mostra a faixa de erro e o chip de falha', () => {
    renderCard(<FlowNodeCard kind="log" runStatus={{ status: 'failed', message: 'variável ausente' }} />)

    expect(screen.getByText('Falhou')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('variável ausente')
  })

  it('esconde engrenagem e ações rápidas no modo somente leitura', () => {
    const onOpenSettings = vi.fn()
    const { container, rerender } = renderCard(
      <FlowNodeCard kind="sleep" onOpenSettings={onOpenSettings} onDuplicate={vi.fn()} onDelete={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Abrir configurações deste node' })).toBeInTheDocument()
    expect(container.querySelector('.flow-node-toolbar')).not.toBeNull()

    rerender(
      <ReactFlowProvider>
        <FlowNodeCard kind="sleep" readOnly onOpenSettings={onOpenSettings} onDuplicate={vi.fn()} onDelete={vi.fn()} />
      </ReactFlowProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Abrir configurações deste node' })).toBeNull()
    expect(container.querySelector('.flow-node-toolbar')).toBeNull()
  })
})
