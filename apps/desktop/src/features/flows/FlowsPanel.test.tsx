import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../test-utils'
import type { FlowState } from './flows.types'
import { FlowsPanel } from './FlowsPanel'

const flow: FlowState = { id: 'flow-1', name: 'Login', executionKind: 'standard', nodes: [], edges: [], createdAtMs: 0, updatedAtMs: 0 }

function renderPanel() {
  const onRenameFlow = vi.fn()
  const onOpenFlow = vi.fn()
  const onRemoveFlow = vi.fn()
  render(
    <FlowsPanel
      flows={[flow]}
      changeMarkers={new Map()}
      onAddFlow={() => 'flow-2'}
      onRenameFlow={onRenameFlow}
      onRemoveFlow={onRemoveFlow}
      onMoveFlow={vi.fn()}
      onOpenFlow={onOpenFlow}
    />,
  )
  return { onRenameFlow, onOpenFlow, onRemoveFlow }
}

const flowItem = () => screen.getByText('Login').closest('button')!

describe('FlowsPanel', () => {
  it('renomeia o flow selecionado com F2', () => {
    const { onRenameFlow, onOpenFlow } = renderPanel()
    fireEvent.click(flowItem())
    expect(onOpenFlow).toHaveBeenCalledWith('flow-1')
    expect(flowItem()).toHaveFocus()

    fireEvent.keyDown(flowItem(), { key: 'F2' })
    const input = screen.getByLabelText('Nome do flow')
    fireEvent.change(input, { target: { value: 'Checkout' } })
    expect(onRenameFlow).toHaveBeenCalledWith('flow-1', 'Checkout')
  })

  it('não renomeia com clique duplo', () => {
    renderPanel()
    fireEvent.doubleClick(flowItem())
    expect(screen.queryByLabelText('Nome do flow')).not.toBeInTheDocument()
  })

  it('remove o flow selecionado com Delete, após a confirmação', () => {
    const { onRemoveFlow } = renderPanel()
    fireEvent.keyDown(flowItem(), { key: 'Delete' })

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Remover flow?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }))
    expect(onRemoveFlow).toHaveBeenCalledWith('flow-1')
  })

  it('mostra os flows na ordem recebida, mesmo com edição mais recente', () => {
    const first: FlowState = { ...flow, id: 'first', name: 'Antigo', createdAtMs: 1, updatedAtMs: 100 }
    const second: FlowState = { ...flow, id: 'second', name: 'Novo', createdAtMs: 2, updatedAtMs: 2 }
    render(
      <FlowsPanel
        flows={[first, second]}
        changeMarkers={new Map()}
        onAddFlow={() => 'flow-3'}
        onRenameFlow={vi.fn()}
        onRemoveFlow={vi.fn()}
        onMoveFlow={vi.fn()}
        onOpenFlow={vi.fn()}
      />,
    )

    const names = screen.getAllByText(/^(Antigo|Novo)$/).map((element) => element.textContent)
    expect(names).toEqual(['Antigo', 'Novo'])
  })

  it('renomeia e remove pelo menu de contexto da linha', () => {
    const { onRemoveFlow } = renderPanel()

    fireEvent.contextMenu(flowItem())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
    expect(screen.getByLabelText('Nome do flow')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByLabelText('Nome do flow'), { key: 'Enter' })

    fireEvent.contextMenu(flowItem())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remover' }))
    expect(onRemoveFlow).toHaveBeenCalledWith('flow-1')
  })
})
