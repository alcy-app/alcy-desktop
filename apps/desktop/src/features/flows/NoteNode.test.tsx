import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { NoteNode } from './NoteNode'
import { simpleFlowNode } from './simple-node-types'
import type { SimpleFlowNodeType, SimpleNodeData } from './simple-node-types'

function renderNote(data: Partial<SimpleNodeData> = {}) {
  const node = simpleFlowNode('note-1', { x: 0, y: 0 }, { kind: 'note', text: 'Lembrete', width: 260, height: 140 })
  const props = { id: node.id, data: { ...node.data, ...data }, selected: false } as unknown as NodeProps<SimpleFlowNodeType>
  return render(
    <ReactFlowProvider>
      <NoteNode {...props} />
    </ReactFlowProvider>,
  )
}

describe('NoteNode', () => {
  it('shows text without an editable field until double-clicked', () => {
    renderNote()

    expect(screen.getByText('Lembrete')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('edits on double-click and exits editing with Escape', () => {
    const onConfigChange = vi.fn()
    renderNote({ onConfigChange })

    fireEvent.doubleClick(screen.getByText('Lembrete'))
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'Lembrete novo' } })
    expect(onConfigChange).toHaveBeenCalledWith({ kind: 'note', text: 'Lembrete novo', width: 260, height: 140 })

    fireEvent.keyDown(textbox, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not enter editing or show actions in read-only mode', () => {
    renderNote({ readOnly: true })

    fireEvent.doubleClick(screen.getByText('Lembrete'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ações do bloco' })).toBeNull()
  })

  it('uses the same three-dot actions menu as operation nodes', () => {
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    const { container } = renderNote({ onDuplicate, onDelete })
    const trigger = screen.getByRole('button', { name: 'Ações do bloco' })
    expect(container.querySelector('.flow-node-toolbar')).toBeNull()
    fireEvent.doubleClick(trigger)
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toHaveClass('ui-menu--static')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar este node' }))
    expect(onDuplicate).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excluir este node' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('opens the actions from a right-click on the note', () => {
    const onDuplicate = vi.fn()
    const { container } = renderNote({ onDuplicate })

    fireEvent.contextMenu(container.querySelector('.flow-node')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar este node' }))

    expect(onDuplicate).toHaveBeenCalledOnce()
  })
})
