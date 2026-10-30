import { StrictMode, useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../../shared/i18n/LanguageProvider'
import { ShortcutsProvider } from '../../../shared/shortcuts/ShortcutsProvider'
import { SHORTCUTS_STORAGE_KEY } from '../../../shared/shortcuts/shortcuts'
import { openModals } from '../../../shared/ui/open-modals'
import { useTabGroups } from '../use-tab-groups'
import type { OpenTabDescriptor } from '../use-open-tabs'
import { OpenTabsBar } from './OpenTabsBar'

const tabs: OpenTabDescriptor[] = ['Orders', 'Payments', 'Users'].map((label) => ({ id: label, label, kind: 'request', fixed: false, preview: false, dirty: label === 'Payments' }))

function setup(initialTabs = tabs) {
  const onCloseMany = vi.fn()
  function Harness() {
    const groups = useTabGroups(initialTabs, () => {})
    const [active, setActive] = useState<string>('Orders')
    return <><button onClick={() => setActive('Payments')}>Activate Payments</button><OpenTabsBar
      tabs={initialTabs}
      tabGroups={groups}
      activeTabId={active}
      onSelect={setActive}
      onPin={() => {}}
      onClose={() => {}}
      onCloseAll={() => {}}
      onCloseOthers={() => {}}
      onCloseUnfixed={() => {}}
      onCloseMany={onCloseMany}
      onToggleFix={() => {}}
      onNewTab={() => {}}
      onReorder={() => {}}
      onReorderGroup={() => {}}
      onSaveTab={() => {}}
      environments={[]}
      activeEnvironmentId={null}
      onEnvironmentChange={() => {}}
    /></>
  }
  render(<StrictMode><LanguageProvider><ShortcutsProvider><Harness /></ShortcutsProvider></LanguageProvider></StrictMode>)
  return { onCloseMany }
}

function createGroup() {
  fireEvent.click(screen.getByRole('tab', { name: 'Payments' }), { ctrlKey: true })
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Orders' }), { clientX: 200, clientY: 25 })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar ao grupo de abas…' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Novo grupo' }))
  const name = screen.getByRole('textbox', { name: 'Nome do grupo' })
  fireEvent.change(name, { target: { value: 'Commerce' } })
  fireEvent.keyDown(name, { key: 'Enter' })
}

describe('OpenTabsBar groups', () => {
  it('Ctrl+G immediately groups selected tabs when no group exists', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }), { ctrlKey: true })
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true })
    expect(screen.getByRole('button', { name: 'Recolher Novo grupo, 2 abas' })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Adicionar ao grupo de abas…' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Nome do grupo' })).toHaveFocus()
  })

  it('Ctrl+G opens the existing-group picker and can add the active tab to a group', () => {
    setup()
    createGroup()
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }))
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true })
    const picker = screen.getByRole('menu', { name: 'Adicionar ao grupo de abas…' })
    expect(within(picker).getByRole('menuitem', { name: 'Novo grupo' })).toHaveFocus()
    fireEvent.click(within(picker).getByRole('menuitem', { name: 'Commerce' }))
    expect(screen.getByRole('button', { name: 'Recolher Commerce, 3 abas' })).toBeInTheDocument()
  })

  it('can create a separate group from the shortcut picker', () => {
    setup()
    createGroup()
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }))
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Novo grupo' }))
    expect(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recolher Novo grupo, 1 aba' })).toBeInTheDocument()
  })

  it('uses the active tab when nothing is selected and supports customized shortcuts', () => {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify({ version: 1, bindings: { groupTabs: ['Ctrl+Shift+G'] } }))
    setup()
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: 'Recolher Novo grupo, 1 aba' })).toBeInTheDocument()
  })

  it('does not group fixed tabs', () => {
    setup(tabs.map((tab) => ({ ...tab, fixed: true })))
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ignores consumed events, held keys, composition and open modals', () => {
    setup()
    const consumed = new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, cancelable: true })
    consumed.preventDefault()
    fireEvent(document, consumed)
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true, isComposing: true })
    fireEvent.keyDown(document, { key: 'g', ctrlKey: true, repeat: true })
    const modal = Symbol('test modal')
    openModals.push(modal)
    try { fireEvent.keyDown(document, { key: 'g', ctrlKey: true }) }
    finally { openModals.splice(openModals.indexOf(modal), 1) }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Recolher Novo grupo/ })).not.toBeInTheDocument()
  })

  it('commits a name on outside click and cancels a pending rename with Escape', () => {
    setup()
    createGroup()
    const groupLabel = screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' })
    fireEvent.contextMenu(groupLabel)
    let name = screen.getByRole('textbox', { name: 'Nome do grupo' })
    expect(name).toHaveFocus()
    fireEvent.change(name, { target: { value: 'Discard this rename' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' })).toBeInTheDocument()
    fireEvent.contextMenu(groupLabel)
    name = screen.getByRole('textbox', { name: 'Nome do grupo' })
    fireEvent.change(name, { target: { value: 'Billing' } })
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('button', { name: 'Recolher Billing, 2 abas' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('groups a selection, edits its color, collapses it and keeps the active editor', () => {
    setup()
    createGroup()
    expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual(['Orders', 'Payments', 'Users'])
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' }))
    const editor = screen.getByRole('dialog', { name: 'Editar grupo de abas' })
    fireEvent.click(within(editor).getByRole('button', { name: 'Verde' }))
    expect(within(editor).getByRole('button', { name: 'Verde' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(editor, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' }))
    expect(screen.queryByRole('tab', { name: 'Orders' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expandir Commerce, 2 abas' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByLabelText('O grupo contém alterações não salvas')).toBeInTheDocument()
    // Activating a hidden member from outside the bar reveals its group.
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }))
    fireEvent.click(screen.getByRole('button', { name: 'Activate Payments' }))
    expect(screen.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true')
  })

  it('confirms unsaved changes before closing every member of the group', async () => {
    const { onCloseMany } = setup()
    createGroup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fechar grupo (2 abas)' }))
    expect(onCloseMany).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' })).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fechar grupo (2 abas)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    await waitFor(() => expect(onCloseMany).toHaveBeenCalledWith(['Orders', 'Payments']))
  })

  it('ungroups without closing tabs and navigates tabs with arrow keys', () => {
    const { onCloseMany } = setup()
    createGroup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Recolher Commerce, 2 abas' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Desagrupar abas' }))
    expect(screen.queryByRole('button', { name: 'Recolher Commerce, 2 abas' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(onCloseMany).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Orders' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Payments' })).toHaveFocus()
  })

  it('moves a tab into an existing group and removes it without closing its resource', () => {
    const { onCloseMany } = setup()
    createGroup()
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Users' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar ao grupo de abas…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Novo grupo' }))
    const name = screen.getByRole('textbox', { name: 'Nome do grupo' })
    fireEvent.change(name, { target: { value: 'Identity' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Payments' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar ao grupo de abas…' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Identity' }))
    expect(screen.getByRole('button', { name: 'Recolher Commerce, 1 aba' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recolher Identity, 2 abas' })).toBeInTheDocument()
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Payments' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover do grupo' }))
    expect(screen.getByRole('button', { name: 'Recolher Identity, 1 aba' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(onCloseMany).not.toHaveBeenCalled()
  })
})
