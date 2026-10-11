import { describe, expect, it, vi } from 'vitest'
import type { ValueMonitorDto } from '../../bindings/list-value-monitors'
import { fireEvent, render, screen } from '../../test-utils'
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
  it('mostra um estado vazio curto sem monitores', () => {
    renderPanel({ monitors: [] })
    expect(screen.getByText('Nenhum monitor ainda. Crie um para validar campos das respostas.')).toBeInTheDocument()
  })

  it('lista o monitor com resumo e mostra as regras como frases legíveis', () => {
    renderPanel()
    expect(screen.getByText('1 campo · 2 regras')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entre 1 e 10 caracteres' })).toBeInTheDocument()
    expect(screen.getByText('Somente letras')).toBeInTheDocument()
    expect(screen.getByText('nome')).toBeInTheDocument()
  })

  it('liga e desliga o monitor pelo switch', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Monitor "Nome curto" ativo' }))
    expect(props.onSetMonitorEnabled).toHaveBeenCalledWith('m1', false)
  })

  it('adiciona um campo ao confirmar com Enter', () => {
    const props = renderPanel()
    const input = screen.getByRole('textbox', { name: 'Adicionar campo monitorado' })
    fireEvent.change(input, { target: { value: 'usuario.email' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onAddField).toHaveBeenCalledWith('m1', 'usuario.email')
  })

  it('abre a edição de uma regra ao clicar nela', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Entre 1 e 10 caracteres' }))
    const max = screen.getByLabelText('Máximo')
    fireEvent.change(max, { target: { value: '20' } })
    expect(props.onUpdateRule).toHaveBeenCalledWith('m1', 'r1', expect.objectContaining({ kind: 'lengthRange', min: 1, max: 20 }))
  })

  it('adiciona uma regra pelo menu agrupado', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Adicionar regra/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Expressão regular' }))
    expect(props.onAddRule).toHaveBeenCalledWith('m1', 'regex')
  })

  it('mostra o erro de validação logo abaixo da regra apontada', () => {
    renderPanel({ error: { kind: 'invalid', message: "expressão regular inválida: '('", monitorId: 'm1', ruleId: 'r1' } })
    expect(screen.getByRole('alert')).toHaveTextContent("expressão regular inválida: '('")
  })
})
