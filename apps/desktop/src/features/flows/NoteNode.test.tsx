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
  it('mostra o texto sem campo editável até o clique duplo', () => {
    renderNote()

    expect(screen.getByText('Lembrete')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('edita com clique duplo e sai da edição com Esc', () => {
    const onConfigChange = vi.fn()
    renderNote({ onConfigChange })

    fireEvent.doubleClick(screen.getByText('Lembrete'))
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'Lembrete novo' } })
    expect(onConfigChange).toHaveBeenCalledWith({ kind: 'note', text: 'Lembrete novo', width: 260, height: 140 })

    fireEvent.keyDown(textbox, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('não entra em edição no modo somente leitura', () => {
    renderNote({ readOnly: true })

    fireEvent.doubleClick(screen.getByText('Lembrete'))
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
