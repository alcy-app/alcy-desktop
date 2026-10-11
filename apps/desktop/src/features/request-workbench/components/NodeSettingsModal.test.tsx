import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import { NodeSettingsModal } from './NodeSettingsModal'

function renderModal(props: Partial<Parameters<typeof NodeSettingsModal>[0]> = {}) {
  const onSave = vi.fn()
  render(
    <NodeSettingsModal
      kind="folder"
      nodeId="f1"
      name="Pedidos"
      authentication={{ type: 'inherit' }}
      variables={[{ name: 'baseUrl', value: 'https://api' }]}
      environmentVariables={[]}
      onSave={onSave}
      onClose={() => {}}
      {...props}
    />,
  )
  return { onSave }
}

describe('NodeSettingsModal — variáveis', () => {
  it('edita, adiciona e remove variáveis, ignorando linhas vazias ao salvar', () => {
    const { onSave } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))
    const names = screen.getAllByLabelText('Nome da variável')
    const values = screen.getAllByLabelText('Valor da variável')
    fireEvent.change(names[1], { target: { value: 'orderId' } })
    fireEvent.change(values[1], { target: { value: '42' } })
    fireEvent.change(values[0], { target: { value: 'https://staging' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))

    expect(onSave).toHaveBeenCalledWith({
      name: 'Pedidos',
      authentication: { type: 'inherit' },
      variables: [
        { name: 'baseUrl', value: 'https://staging' },
        { name: 'orderId', value: '42' },
      ],
    })
  })

  it('bloqueia salvar com nome repetido ou com chaves', () => {
    const { onSave } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))
    const newName = screen.getAllByLabelText('Nome da variável')[1]
    fireEvent.change(newName, { target: { value: 'baseUrl' } })
    expect(screen.getByRole('alert')).toHaveTextContent('A variável "baseUrl" está repetida.')
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled()

    fireEvent.change(newName, { target: { value: '{{x}}' } })
    expect(screen.getByRole('alert')).toHaveTextContent('O nome "{{x}}" não pode conter chaves.')

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('remove uma variável', () => {
    const { onSave } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Remover variável baseUrl' }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ variables: [] }))
  })
})
