import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { FlowsPanel } from './FlowsPanel'

function renderMenu(importingFlow = false) {
  const onImportFlow = vi.fn()
  const onImportLoadTest = vi.fn()
  render(<FlowsPanel flows={[]} folders={[]} changeMarkers={new Map()}
    onAddFlow={() => 'flow'} onAddFlowFromTemplate={() => 'template'}
    onRenameFlow={vi.fn()} onRemoveFlow={vi.fn()} onMoveFlow={vi.fn()} onOpenFlow={vi.fn()}
    onAddFolder={() => 'folder'} onRenameFolder={vi.fn()} onRemoveFolder={vi.fn()}
    onMoveFolder={vi.fn()} onMoveFlowToFolder={vi.fn()}
    onImportFlow={onImportFlow} onImportLoadTest={onImportLoadTest} importingFlow={importingFlow} />)
  fireEvent.click(screen.getByRole('button', { name: 'Importar flow' }))
  return { onImportFlow, onImportLoadTest }
}

describe('direct flow import', () => {
  it('opens the shared file selector directly without a type menu', () => {
    const { onImportFlow, onImportLoadTest } = renderMenu()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onImportFlow).toHaveBeenCalledOnce()
    expect(onImportLoadTest).not.toHaveBeenCalled()
  })

  it('prevents overlapping imports while a flow is being saved', () => {
    const { onImportFlow } = renderMenu(true)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Importar flow' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Importar flow' })).toBeDisabled()
    expect(onImportFlow).not.toHaveBeenCalled()
  })
})
