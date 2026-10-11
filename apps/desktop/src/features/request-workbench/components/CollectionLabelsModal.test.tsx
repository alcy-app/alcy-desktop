import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import type { CollectionLabelDto } from '../../../bindings/list-collections'
import { CollectionLabelsModal } from './CollectionLabelsModal'

const catalog: CollectionLabelDto[] = [
  { name: 'Legado', color: 'gray' },
  { name: 'Pagamentos', color: 'green' },
]
const usage = new Map([
  ['legado', 2],
  ['pagamentos', 1],
])

function renderModal(overrides: Partial<Parameters<typeof CollectionLabelsModal>[0]> = {}) {
  const props = {
    catalog,
    usage,
    targets: { title: 'Rótulos de "API"', labelSets: [[{ name: 'Pagamentos', color: 'green' as const }]] },
    onAssign: vi.fn(),
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    onRemove: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<CollectionLabelsModal {...props} />)
  return props
}

describe('CollectionLabelsModal', () => {
  it('marca os rótulos da collection e alterna um deles', () => {
    const { onAssign } = renderModal()

    expect(screen.getByRole('checkbox', { name: 'Pagamentos' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Legado' })).not.toBeChecked()
    expect(screen.getByText('2 collections')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Legado' }))
    expect(onAssign).toHaveBeenCalledWith({ name: 'Legado', color: 'gray' }, true)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Pagamentos' }))
    expect(onAssign).toHaveBeenLastCalledWith({ name: 'Pagamentos', color: 'green' }, false)
  })

  it('cria um rótulo novo com a cor escolhida', () => {
    const { onAssign } = renderModal()

    fireEvent.change(screen.getByLabelText('Novo rótulo'), { target: { value: '  Interno ' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Roxo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }))

    expect(onAssign).toHaveBeenCalledWith({ name: 'Interno', color: 'purple' }, true)
    expect(screen.getByLabelText('Novo rótulo')).toHaveValue('')
  })

  it('reaproveita um rótulo existente pelo nome e bloqueia um já atribuído', () => {
    const { onAssign } = renderModal()

    fireEvent.change(screen.getByLabelText('Novo rótulo'), { target: { value: 'legado' } })
    expect(screen.getByText('O rótulo "Legado" já existe e será adicionado com a cor dele.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(onAssign).toHaveBeenCalledWith({ name: 'Legado', color: 'gray' }, true)

    fireEvent.change(screen.getByLabelText('Novo rótulo'), { target: { value: 'PAGAMENTOS' } })
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeDisabled()
  })

  it('renomeia e troca a cor de um rótulo', () => {
    const { onRename, onRecolor } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Editar rótulo "Legado"' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do rótulo' }), { target: { value: 'Antigo' } })
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Cor do rótulo "Legado"' })).getByRole('radio', { name: 'Laranja' }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar rótulo' }))

    expect(onRecolor).toHaveBeenCalledWith('Legado', 'orange')
    expect(onRename).toHaveBeenCalledWith('Legado', 'Antigo')
  })

  it('pede confirmação antes de excluir um rótulo de todas as collections', () => {
    const { onRemove } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Excluir rótulo "Legado"' }))
    const confirm = screen.getByRole('dialog', { name: 'Excluir rótulo' })
    expect(confirm).toHaveTextContent('O rótulo "Legado" será removido de 2 collection(s).')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remover' }))

    expect(onRemove).toHaveBeenCalledWith('Legado')
  })

  it('sem collection-alvo só gerencia: sem checkboxes nem criação', () => {
    renderModal({ targets: undefined, onAssign: undefined })

    expect(screen.getByRole('dialog', { name: 'Gerenciar rótulos' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Novo rótulo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Editar rótulo "Pagamentos"' })).toBeInTheDocument()
  })

  it('em várias collections marca o rótulo parcial e o liga em todas', () => {
    const { onAssign } = renderModal({
      targets: {
        title: 'Rótulos de 2 collections',
        labelSets: [[{ name: 'Pagamentos', color: 'green' }, { name: 'Legado', color: 'gray' }], [{ name: 'Pagamentos', color: 'green' }]],
      },
    })

    expect(screen.getByRole('dialog', { name: 'Rótulos de 2 collections' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Pagamentos' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Legado' })).toBePartiallyChecked()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Legado' }))
    expect(onAssign).toHaveBeenCalledWith({ name: 'Legado', color: 'gray' }, true)

    fireEvent.change(screen.getByLabelText('Novo rótulo'), { target: { value: 'legado' } })
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeEnabled()
  })
})
