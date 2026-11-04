import { describe, expect, it, vi } from 'vitest'
import type { ValueMonitorDto } from '../../bindings/list-value-monitors'
import { fireEvent, render, screen } from '../../test-utils'
import { takeMentionRequests } from '../agent/agent-mention-bridge'
import { ValueMonitorsPanel, type ValueMonitorsPanelProps } from './ValueMonitorsPanel'

const monitor: ValueMonitorDto = {
  id: 'm1',
  name: 'Nome curto',
  enabled: true,
  fields: ['nome'],
  rules: [
    { id: 'r1', kind: 'lengthRange', min: 1, max: 10 },
    { id: 'r2', kind: 'lettersOnly' },
  ],
}

function renderPanel(overrides: Partial<ValueMonitorsPanelProps> = {}) {
  const props: ValueMonitorsPanelProps = {
    monitors: [monitor],
    error: null,
    onAddMonitor: vi.fn(() => 'new'),
    onRemoveMonitor: vi.fn(),
    onRenameMonitor: vi.fn(),
    onSetMonitorEnabled: vi.fn(),
    onAddField: vi.fn(),
    onRemoveField: vi.fn(),
    onAddRule: vi.fn(() => 'rule-new'),
    onUpdateRule: vi.fn(),
    onRemoveRule: vi.fn(),
    ...overrides,
  }
  render(<ValueMonitorsPanel {...props} />)
  return props
}

describe('ValueMonitorsPanel', () => {
  it('shows a short empty state without monitors', () => {
    renderPanel({ monitors: [] })
    expect(screen.getByText('Nenhum monitor ainda. Crie um para validar campos das respostas.')).toBeInTheDocument()
  })

  it('lists the monitor with a summary and shows the rules as readable sentences', () => {
    renderPanel()
    expect(screen.getByText('1 campo · 2 regras')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entre 1 e 10 caracteres' })).toBeInTheDocument()
    expect(screen.getByText('Somente letras')).toBeInTheDocument()
    expect(screen.getByText('nome')).toBeInTheDocument()
  })

  it('turns the monitor on and off with the switch', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Monitor "Nome curto" ativo' }))
    expect(props.onSetMonitorEnabled).toHaveBeenCalledWith('m1', false)
  })

  it('renames the monitor from the options menu', () => {
    const props = renderPanel()
    // The name in the detail is read-only: renaming goes through the menu.
    expect(screen.queryByRole('textbox', { name: 'Nome do monitor' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Nome curto' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
    const input = screen.getByRole('textbox', { name: 'Nome do monitor' })
    fireEvent.change(input, { target: { value: 'Outro nome' } })
    expect(props.onRenameMonitor).toHaveBeenCalledWith('m1', 'Outro nome')
  })

  it('opens the options menu with a right click on the row', () => {
    renderPanel()
    fireEvent.contextMenu(screen.getByText('1 campo · 2 regras'))
    expect(screen.getByRole('menu', { name: 'Mais opções de Nome curto' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Renomear' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Remover' })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('mentions the monitor in the agent chat from the options menu', () => {
    takeMentionRequests()
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Nome curto' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mencionar no chat' }))

    expect(takeMentionRequests()).toEqual([{ kind: 'monitor', id: 'm1', label: 'Nome curto' }])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('renames with F2 and asks for confirmation to remove with Delete on the row', () => {
    const props = renderPanel()
    const row = screen.getByRole('button', { name: /^Nome curto/ })
    fireEvent.keyDown(row, { key: 'F2' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do monitor' }), { target: { value: 'Outro' } })
    expect(props.onRenameMonitor).toHaveBeenCalledWith('m1', 'Outro')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome do monitor' }), { key: 'Enter' })
    // Focus returns to the row, to keep using the shortcuts.
    expect(screen.getByRole('button', { name: /^Nome curto/ })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('button', { name: /^Nome curto/ }), { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }))
    expect(props.onRemoveMonitor).toHaveBeenCalledWith('m1')
  })

  it('removes the monitor from the options menu after confirming', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Nome curto' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }))
    expect(props.onRemoveMonitor).toHaveBeenCalledWith('m1')
  })

  it('adds a field when confirming with Enter', () => {
    const props = renderPanel()
    const input = screen.getByRole('textbox', { name: 'Adicionar campo monitorado' })
    fireEvent.change(input, { target: { value: 'usuario.email' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onAddField).toHaveBeenCalledWith('m1', 'usuario.email')
  })

  it('opens a rule for editing when clicked', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Entre 1 e 10 caracteres' }))
    const max = screen.getByLabelText('Máximo')
    fireEvent.change(max, { target: { value: '20' } })
    expect(props.onUpdateRule).toHaveBeenCalledWith('m1', 'r1', expect.objectContaining({ kind: 'lengthRange', min: 1, max: 20 }))
  })

  it('adds a rule from the grouped menu', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Adicionar regra/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Expressão regular' }))
    expect(props.onAddRule).toHaveBeenCalledWith('m1', 'regex')
  })

  it('shows the validation error right below the rule it points at', () => {
    renderPanel({ error: { kind: 'invalid', message: "expressão regular inválida: '('", monitorId: 'm1', ruleId: 'r1' } })
    expect(screen.getByRole('alert')).toHaveTextContent("expressão regular inválida: '('")
  })
})
