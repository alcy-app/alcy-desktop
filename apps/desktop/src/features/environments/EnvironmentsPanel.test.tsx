import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { EnvironmentsPanel } from './EnvironmentsPanel'

const noop = () => {}

describe('EnvironmentsPanel', () => {
  it('renders the rename input outside a button so clicking it keeps the edit open', () => {
    const onSelectEnvironment = vi.fn()
    render(
      <EnvironmentsPanel
        environments={[{ id: 'env-1', name: 'Local', variables: [] }]}
        activeEnvironmentId="env-1"
        onSelectEnvironment={onSelectEnvironment}
        onAddEnvironment={noop}
        onRemoveEnvironment={noop}
        onDuplicateEnvironment={noop}
        onRenameEnvironment={noop}
        onMoveEnvironment={noop}
        onAddVariable={noop}
        onUpdateVariable={noop}
        onRemoveVariable={noop}
        onMoveVariable={noop}
        onReplaceVariables={noop}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Local' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
    const input = screen.getByRole('textbox', { name: 'Nome do ambiente' })

    // Input aninhado em <button> perde o foco para o botão ao ser clicado, fechando a edição.
    expect(input.closest('button')).toBeNull()

    fireEvent.click(input)
    expect(screen.getByRole('textbox', { name: 'Nome do ambiente' })).toBe(input)
    expect(onSelectEnvironment).not.toHaveBeenCalled()
  })

  it('avisa quando valores sensíveis não puderam ser lidos nesta máquina', () => {
    render(
      <EnvironmentsPanel
        environments={[{ id: 'env-1', name: 'Local', variables: [] }]}
        unreadableSecrets={['Local › token']}
        activeEnvironmentId="env-1"
        onSelectEnvironment={noop}
        onAddEnvironment={noop}
        onRemoveEnvironment={noop}
        onDuplicateEnvironment={noop}
        onRenameEnvironment={noop}
        onMoveEnvironment={noop}
        onAddVariable={noop}
        onUpdateVariable={noop}
        onRemoveVariable={noop}
        onMoveVariable={noop}
        onReplaceVariables={noop}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Não foi possível ler nesta máquina o valor de: Local › token.')
  })

  describe('reordenação', () => {
    const environments = [
      { id: 'env-1', name: 'Local', variables: [] },
      { id: 'env-2', name: 'Staging', variables: [] },
      {
        id: 'env-3',
        name: 'Produção',
        variables: [
          { id: 'var-1', name: 'baseUrl', value: 'https://api', sensitive: false },
          { id: 'var-2', name: 'token', value: 'secret', sensitive: true },
        ],
      },
    ]

    const renderPanel = (overrides: Partial<Parameters<typeof EnvironmentsPanel>[0]> = {}) =>
      render(
        <EnvironmentsPanel
          environments={environments}
          activeEnvironmentId="env-3"
          onSelectEnvironment={noop}
          onAddEnvironment={noop}
          onRemoveEnvironment={noop}
          onDuplicateEnvironment={noop}
          onRenameEnvironment={noop}
          onMoveEnvironment={noop}
          onAddVariable={noop}
          onUpdateVariable={noop}
          onRemoveVariable={noop}
          onMoveVariable={noop}
          onReplaceVariables={noop}
          {...overrides}
        />,
      )

    it('duplica o ambiente pelo menu de opções da linha', () => {
      const onDuplicateEnvironment = vi.fn()
      renderPanel({ onDuplicateEnvironment })

      fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Staging' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar' }))
      expect(onDuplicateEnvironment).toHaveBeenCalledWith('env-2')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('desabilita Remover no menu quando só há um ambiente', () => {
      renderPanel({ environments: [environments[0]], activeEnvironmentId: 'env-1' })

      fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Local' }))
      expect(screen.getByRole('menuitem', { name: 'Remover' })).toBeDisabled()
    })

    it('move um ambiente pelo teclado e anuncia a nova posição', () => {
      const onMoveEnvironment = vi.fn()
      renderPanel({ onMoveEnvironment })

      fireEvent.keyDown(screen.getByRole('button', { name: 'Reordenar ambiente Staging' }), { key: 'ArrowUp' })
      expect(onMoveEnvironment).toHaveBeenLastCalledWith('env-2', 'env-1', 'before')
      expect(screen.getByText('Staging movido para a posição 1 de 3')).toBeInTheDocument()

      fireEvent.keyDown(screen.getByRole('button', { name: 'Reordenar ambiente Local' }), { key: 'End' })
      expect(onMoveEnvironment).toHaveBeenLastCalledWith('env-1', 'env-3', 'after')
    })

    it('não move além dos limites nem com modificadores', () => {
      const onMoveEnvironment = vi.fn()
      renderPanel({ onMoveEnvironment })

      fireEvent.keyDown(screen.getByRole('button', { name: 'Reordenar ambiente Local' }), { key: 'ArrowUp' })
      fireEvent.keyDown(screen.getByRole('button', { name: 'Reordenar ambiente Produção' }), { key: 'ArrowDown' })
      fireEvent.keyDown(screen.getByRole('button', { name: 'Reordenar ambiente Staging' }), {
        key: 'ArrowUp',
        ctrlKey: true,
      })
      expect(onMoveEnvironment).not.toHaveBeenCalled()
    })

    it('move uma variável do ambiente ativo pelo teclado', () => {
      const onMoveVariable = vi.fn()
      renderPanel({ onMoveVariable })

      fireEvent.keyDown(screen.getByRole('button', { name: 'Reordenar variável baseUrl' }), { key: 'ArrowDown' })
      expect(onMoveVariable).toHaveBeenCalledWith('env-3', 'var-1', 'var-2', 'after')
    })

    it('desabilita a alça quando só há um item', () => {
      renderPanel({ environments: [environments[0]], activeEnvironmentId: 'env-1' })

      expect(screen.getByRole('button', { name: 'Reordenar ambiente Local' })).toBeDisabled()
    })
  })
})
