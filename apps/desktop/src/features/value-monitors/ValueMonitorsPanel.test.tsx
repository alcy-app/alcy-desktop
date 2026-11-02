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

  it('renomeia o monitor pelo menu de opções', () => {
    const props = renderPanel()
    // O nome no detalhe é só leitura: renomear passa pelo menu.
    expect(screen.queryByRole('textbox', { name: 'Nome do monitor' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Nome curto' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
    const input = screen.getByRole('textbox', { name: 'Nome do monitor' })
    fireEvent.change(input, { target: { value: 'Outro nome' } })
    expect(props.onRenameMonitor).toHaveBeenCalledWith('m1', 'Outro nome')
  })

  it('abre o menu de opções com o botão direito na linha', () => {
    renderPanel()
    fireEvent.contextMenu(screen.getByText('1 campo · 2 regras'))
    expect(screen.getByRole('menu', { name: 'Mais opções de Nome curto' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Renomear' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Remover' })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('renomeia com F2 e pede confirmação para remover com Delete na linha', () => {
    const props = renderPanel()
    const row = screen.getByRole('button', { name: /^Nome curto/ })
    fireEvent.keyDown(row, { key: 'F2' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do monitor' }), { target: { value: 'Outro' } })
    expect(props.onRenameMonitor).toHaveBeenCalledWith('m1', 'Outro')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome do monitor' }), { key: 'Enter' })
    // O foco volta à linha, para seguir usando os atalhos.
    expect(screen.getByRole('button', { name: /^Nome curto/ })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('button', { name: /^Nome curto/ }), { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }))
    expect(props.onRemoveMonitor).toHaveBeenCalledWith('m1')
  })

  it('remove o monitor pelo menu de opções após confirmar', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Nome curto' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }))
    expect(props.onRemoveMonitor).toHaveBeenCalledWith('m1')
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
