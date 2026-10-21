import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import type { FlowFolderDto } from '../../bindings/list-flows'
import type { FlowState } from './flows.types'
import { FlowsPanel } from './FlowsPanel'
import { FLOW_TEMPLATES } from './flow-templates'

const flow: FlowState = { id: 'flow-1', name: 'Login', executionKind: 'standard', nodes: [], edges: [], createdAtMs: 0, updatedAtMs: 0 }

function renderPanel({ loadTesting = false }: { loadTesting?: boolean } = {}) {
  const onRenameFlow = vi.fn()
  const onOpenFlow = vi.fn()
  const onRemoveFlow = vi.fn()
  const onAddFlowFromTemplate = vi.fn(() => 'template-flow')
  render(
    <FlowsPanel
      folders={[]}
      onAddFolder={vi.fn()}
      onRenameFolder={vi.fn()}
      onRemoveFolder={vi.fn()}
      onMoveFolder={vi.fn()}
      onMoveFlowToFolder={vi.fn()}
      flows={[flow]}
      changeMarkers={new Map()}
      onAddFlow={() => 'flow-2'}
      onAddFlowFromTemplate={onAddFlowFromTemplate}
      onAddLoadFlow={loadTesting ? () => 'load-flow' : undefined}
      onRenameFlow={onRenameFlow}
      onRemoveFlow={onRemoveFlow}
      onMoveFlow={vi.fn()}
      onOpenFlow={onOpenFlow}
    />,
  )
  return { onRenameFlow, onOpenFlow, onRemoveFlow, onAddFlowFromTemplate }
}

const flowItem = () => screen.getByText('Login').closest('button')!

function createFromToolbar(name: 'Novo flow em branco' | 'Criar pasta') {
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar flow ou pasta' }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

describe('FlowsPanel', () => {
  it('selects a template without creating it, then creates and opens exactly one flow', () => {
    const { onAddFlowFromTemplate, onOpenFlow } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar flow ou pasta' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Templates' }))
    const dialog = screen.getByRole('dialog', { name: 'Templates' })
    const cards = within(dialog).getAllByRole('button', { pressed: false })
    const blank = within(dialog).getByRole('button', { name: 'Flow em branco', pressed: true })
    expect(blank).toHaveFocus()
    expect(dialog.querySelector('.flow-templates-grid')?.firstElementChild).toContainElement(blank)
    expect(cards).toHaveLength(FLOW_TEMPLATES.filter((template) => template.executionKind === 'standard').length - 1)
    expect(within(dialog).queryByRole('button', { name: 'Teste de carga básico' })).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Encadeamento de requests' }))
    expect(blank).toHaveAttribute('aria-pressed', 'false')
    expect(onAddFlowFromTemplate).not.toHaveBeenCalled()
    const create = within(dialog).getByRole('button', { name: 'Criar flow' })
    fireEvent.click(create)
    fireEvent.click(create)
    expect(onAddFlowFromTemplate).toHaveBeenCalledExactlyOnceWith('chainedRequests', undefined)
    expect(onOpenFlow).toHaveBeenCalledExactlyOnceWith('template-flow')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cancels with Escape and returns focus to the toolbar without creating a flow', async () => {
    const { onAddFlowFromTemplate } = renderPanel()
    const trigger = screen.getByRole('button', { name: 'Adicionar flow ou pasta' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Templates' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onAddFlowFromTemplate).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
  })

  it('creates the initially selected blank flow and offers load templates only when enabled', () => {
    const { onAddFlowFromTemplate } = renderPanel({ loadTesting: true })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar flow ou pasta' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Templates' }))
    expect(screen.getByRole('button', { name: 'Teste de carga básico' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Criar flow' }))
    expect(onAddFlowFromTemplate).toHaveBeenCalledExactlyOnceWith('blank', undefined)
  })

  it('renames the focused flow with F2', () => {
    const { onRenameFlow, onOpenFlow } = renderPanel()
    fireEvent.click(flowItem())
    expect(onOpenFlow).toHaveBeenCalledWith('flow-1')
    expect(flowItem()).toHaveFocus()

    fireEvent.keyDown(flowItem(), { key: 'F2' })
    const input = screen.getByLabelText('Nome do flow')
    fireEvent.change(input, { target: { value: 'Checkout' } })
    expect(onRenameFlow).toHaveBeenCalledWith('flow-1', 'Checkout')
  })

  it('does not rename on double click', () => {
    renderPanel()
    fireEvent.doubleClick(flowItem())
    expect(screen.queryByLabelText('Nome do flow')).not.toBeInTheDocument()
  })

  it('removes the focused flow with Delete after confirmation', () => {
    const { onRemoveFlow } = renderPanel()
    fireEvent.keyDown(flowItem(), { key: 'Delete' })

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Remover flow?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }))
    expect(onRemoveFlow).toHaveBeenCalledWith('flow-1')
  })

  it('preserves array order regardless of update timestamps', () => {
    const first: FlowState = { ...flow, id: 'first', name: 'Antigo', createdAtMs: 1, updatedAtMs: 100 }
    const second: FlowState = { ...flow, id: 'second', name: 'Novo', createdAtMs: 2, updatedAtMs: 2 }
    render(
      <FlowsPanel
        folders={[]}
      onAddFolder={vi.fn()}
      onRenameFolder={vi.fn()}
      onRemoveFolder={vi.fn()}
      onMoveFolder={vi.fn()}
      onMoveFlowToFolder={vi.fn()}
      flows={[first, second]}
        changeMarkers={new Map()}
        onAddFlow={() => 'flow-3'}
        onAddFlowFromTemplate={vi.fn()}
        onRenameFlow={vi.fn()}
        onRemoveFlow={vi.fn()}
        onMoveFlow={vi.fn()}
        onOpenFlow={vi.fn()}
      />,
    )

    const names = screen.getAllByText(/^(Antigo|Novo)$/).map((element) => element.textContent)
    expect(names).toEqual(['Antigo', 'Novo'])
  })

  it('renames and removes through the row context menu', () => {
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

  it('keeps the toolbar pinned outside the scrolling body that holds the list', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Buscar flows' }))

    const toolbar = document.querySelector('.sidebar-panel-toolbar') as HTMLElement
    const scrollBody = document.querySelector('.sidebar-panel-scroll') as HTMLElement
    expect(toolbar).toContainElement(screen.getByRole('textbox'))
    expect(toolbar).not.toContainElement(scrollBody)
    expect(scrollBody).toContainElement(flowItem())
  })
})


function FolderPanel({ count = 1, onOpenFlow = vi.fn() }: { count?: number; onOpenFlow?: (id: string) => void }) {
  const [folders, setFolders] = useState<FlowFolderDto[]>([{ id: 'folder', name: 'Checkout', flowIds: ['flow-1'] }])
  const [flows, setFlows] = useState<FlowState[]>(Array.from({ length: count }, (_, index) => ({ ...flow, id: index === 0 ? flow.id : 'flow-' + (index + 1), name: index === 0 ? flow.name : 'Flow ' + (index + 1) })))
  return <FlowsPanel flows={flows} folders={folders} changeMarkers={new Map()}
    onAddFlowFromTemplate={(_templateId, folderId) => {
      setFlows((current) => [...current, { ...flow, id: 'template-flow', name: 'Template criado' }])
      setFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, flowIds: [...folder.flowIds, 'template-flow'] } : folder))
      return 'template-flow'
    }}
    onAddFlow={(folderId) => {
      setFlows((current) => [...current, { ...flow, id: 'created', name: 'Novo flow' }])
      setFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, flowIds: [...folder.flowIds, 'created'] } : folder))
      return 'created'
    }}
    onAddFolder={() => { setFolders((current) => [...current, { id: 'new-folder', name: 'Nova pasta', flowIds: [] }]); return 'new-folder' }}
    onRenameFolder={(id, name) => setFolders((current) => current.map((folder) => folder.id === id ? { ...folder, name } : folder))}
    onRemoveFolder={(id) => setFolders((current) => current.filter((folder) => folder.id !== id))}
    onMoveFlowToFolder={(id, folderId) => setFolders((current) => current.map((folder) => ({ ...folder, flowIds: folder.id === folderId ? [...folder.flowIds.filter((member) => member !== id), id] : folder.flowIds.filter((member) => member !== id) })))}
    onMoveFolder={vi.fn()} onRenameFlow={vi.fn()} onRemoveFlow={vi.fn()} onMoveFlow={vi.fn()} onOpenFlow={onOpenFlow} />
}

describe('flow folders', () => {
  it('keeps folder menus above virtualized rows without starting a row drag from menu actions', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    try {
      render(<FolderPanel />)
      createFromToolbar('Criar pasta')
      fireEvent.keyDown(screen.getByLabelText('Nome da pasta'), { key: 'Enter' })
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Checkout' }))
      const menu = screen.getByRole('menu')
      expect(menu.parentElement).toBe(document.body)
      expect(menu).toHaveClass('ui-menu--portal')
      expect(document.querySelector('.flows-list')).not.toContainElement(menu)
      const rename = within(menu).getByRole('menuitem', { name: 'Renomear' })
      fireEvent.pointerDown(rename, { button: 0, clientX: 5, clientY: 5 })
      fireEvent.pointerMove(window, { clientX: 5, clientY: 25 })
      expect(document.querySelector('.flows-list-row--dragging')).not.toBeInTheDocument()
      expect(menu).toBeInTheDocument()
      fireEvent.pointerUp(window, { clientX: 5, clientY: 25 })
      fireEvent.click(rename)
      expect(screen.getByLabelText('Nome da pasta')).toHaveFocus()
    } finally { vi.unstubAllGlobals() }
  })

  it('starts closed on entry and closes again when returning to the flows panel', () => {
    function SwitchablePanel() {
      const [visible, setVisible] = useState(true)
      return <><button onClick={() => setVisible((current) => !current)}>Switch panel</button>{visible && <FolderPanel />}</>
    }
    render(<SwitchablePanel />)
    expect(screen.getByRole('button', { name: 'Checkout' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(screen.getByText('Login')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch panel' }))
    expect(screen.getByRole('button', { name: 'Checkout' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
  })

  it('creates from a collapsed folder gallery, expands the folder and opens the flow', () => {
    const onOpenFlow = vi.fn()
    render(<FolderPanel onOpenFlow={onOpenFlow} />)
    const folder = screen.getByRole('button', { name: 'Checkout' })
    expect(folder).toHaveAttribute('aria-expanded', 'false')
    fireEvent.contextMenu(folder)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Templates' }))
    fireEvent.click(screen.getByRole('button', { name: 'Repetição com intervalo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Criar flow' }))
    expect(folder).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Template criado').closest('.flows-list-row')).toHaveClass('flows-list-row--nested')
    expect(onOpenFlow).toHaveBeenCalledExactlyOnceWith('template-flow')
  })

  it('creates and renames an empty folder with the keyboard', () => {
    render(<FolderPanel />)
    expect(screen.queryByRole('button', { name: 'Criar pasta' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar flow ou pasta' }))
    const menu = screen.getByRole('menu')
    const blankFlow = within(menu).getByRole('menuitem', { name: 'Novo flow em branco' })
    expect(blankFlow.querySelector('svg')).toBeInTheDocument()
    const templates = within(menu).getByRole('menuitem', { name: 'Templates' })
    const folder = within(menu).getByRole('menuitem', { name: 'Criar pasta' })
    expect(blankFlow.nextElementSibling).toHaveAttribute('role', 'separator')
    expect(blankFlow.nextElementSibling?.nextElementSibling).toBe(templates)
    expect(templates.querySelector('svg')).not.toBeInTheDocument()
    expect(templates.nextElementSibling).toBe(folder)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Criar pasta' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const input = screen.getByLabelText('Nome da pasta')
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'Payments' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Payments' })).toBeInTheDocument()
  })

  it('collapses folders and reveals matching children during search', () => {
    render(<FolderPanel />)
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(screen.getByText('Login')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Buscar flows' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'login' } })
    expect(screen.getByText('Login')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Checkout' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'checkout' } })
    expect(screen.getByText('Login')).toBeInTheDocument()
  })

  it('creates flows inside a folder through its menu', () => {
    render(<FolderPanel />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Checkout' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Novo flow' }))
    expect(screen.getByLabelText('Nome do flow').closest('.flows-list-row')).toHaveClass('flows-list-row--nested')
  })

  it('moves flows to the root and back through the destination dialog', () => {
    render(<FolderPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    const move = (destination: string) => {
      fireEvent.contextMenu(flowItem())
      fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para pasta' }))
      fireEvent.change(screen.getByLabelText('Pasta de destino'), { target: { value: destination } })
      fireEvent.click(screen.getByRole('button', { name: 'Mover' }))
    }
    move('')
    expect(flowItem().closest('.flows-list-row')).not.toHaveClass('flows-list-row--nested')
    move('folder')
    expect(flowItem().closest('.flows-list-row')).toHaveClass('flows-list-row--nested')
  })

  it('removes a folder after confirmation and keeps its flows at the root', () => {
    render(<FolderPanel />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Checkout' }), { key: 'Delete' })
    expect(within(screen.getByRole('dialog')).getByText(/Os flows serão movidos/)).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remover' }))
    expect(screen.queryByRole('button', { name: 'Checkout' })).not.toBeInTheDocument()
    expect(flowItem().closest('.flows-list-row')).not.toHaveClass('flows-list-row--nested')
  })

  it('bounds mounted rows and reveals new flows and folders outside the viewport', () => {
    render(<FolderPanel count={1000} />)
    fireEvent.click(screen.getByRole('button', { name: 'Checkout' }))
    expect(screen.getAllByRole('listitem').length).toBeLessThan(40)
    createFromToolbar('Novo flow em branco')
    expect(screen.getByLabelText('Nome do flow')).toHaveFocus()
    fireEvent.keyDown(screen.getByLabelText('Nome do flow'), { key: 'Enter' })
    createFromToolbar('Criar pasta')
    expect(screen.getByLabelText('Nome da pasta')).toHaveFocus()
  })

  it('navigates beyond mounted rows with the keyboard', async () => {
    render(<FolderPanel count={1000} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Checkout' }), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Checkout' }), { key: 'End' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Flow 1000' })).toHaveFocus())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Flow 1000' }), { key: 'Home' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Checkout' })).toHaveFocus())
  })

  it('moves flows by pointer drag into an empty folder and back to the root', () => {
    const previousHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
    const hitTest = vi.fn()
    vi.stubGlobal('PointerEvent', MouseEvent)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hitTest })
    try {
      render(<FolderPanel />)
      fireEvent.click(screen.getByRole('button', { name: 'Checkout' }))
      createFromToolbar('Criar pasta')
      fireEvent.keyDown(screen.getByLabelText('Nome da pasta'), { key: 'Enter' })
      hitTest.mockReturnValue(screen.getByRole('button', { name: 'Nova pasta' }))
      fireEvent.pointerDown(flowItem(), { button: 0, clientX: 5, clientY: 5 })
      fireEvent.pointerMove(window, { clientX: 5, clientY: 15 })
      fireEvent.pointerUp(window, { clientX: 5, clientY: 15 })
      fireEvent.click(screen.getByRole('button', { name: 'Nova pasta' }))
      expect(screen.queryByText('Login')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Nova pasta' }))

      fireEvent.pointerDown(flowItem(), { button: 0, clientX: 5, clientY: 5 })
      fireEvent.pointerMove(window, { clientX: 5, clientY: 15 })
      hitTest.mockReturnValue(screen.getByText('Flows fora de pastas'))
      fireEvent.pointerMove(window, { clientX: 5, clientY: 25 })
      fireEvent.pointerUp(window, { clientX: 5, clientY: 25 })
      expect(flowItem().closest('.flows-list-row')).not.toHaveClass('flows-list-row--nested')
    } finally {
      vi.unstubAllGlobals()
      if (previousHitTest) Object.defineProperty(document, 'elementFromPoint', previousHitTest)
      else Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })
})
