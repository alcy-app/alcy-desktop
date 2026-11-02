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

    it('renomeia com F2 e pede confirmação para remover com Delete na linha', () => {
      const onRenameEnvironment = vi.fn()
      const onRemoveEnvironment = vi.fn()
      renderPanel({ onRenameEnvironment, onRemoveEnvironment })

      fireEvent.keyDown(screen.getByRole('button', { name: 'Staging' }), { key: 'F2' })
      const input = screen.getByRole('textbox', { name: 'Nome do ambiente' })
      fireEvent.change(input, { target: { value: 'QA' } })
      expect(onRenameEnvironment).toHaveBeenCalledWith('env-2', 'QA')
      fireEvent.keyDown(input, { key: 'Escape' })
      // O foco volta à linha, para seguir usando os atalhos.
      expect(screen.getByRole('button', { name: 'Staging' })).toHaveFocus()

      fireEvent.keyDown(screen.getByRole('button', { name: 'Staging' }), { key: 'Delete' })
      fireEvent.click(screen.getByRole('button', { name: 'Remover' }))
      expect(onRemoveEnvironment).toHaveBeenCalledWith('env-2')
    })

    it('abre o menu de opções com o botão direito na linha', () => {
      renderPanel()

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Staging' }))
      expect(screen.getByRole('menu', { name: 'Mais opções de Staging' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Renomear' })).toBeInTheDocument()

      fireEvent.pointerDown(document.body)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('ignora Delete quando só há um ambiente', () => {
      renderPanel({ environments: [environments[0]], activeEnvironmentId: 'env-1' })

      fireEvent.keyDown(screen.getByRole('button', { name: /^Local/ }), { key: 'Delete' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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

  describe('variable search', () => {
    const environments = [
      {
        id: 'env-1',
        name: 'Local',
        variables: [
          { id: 'var-1', name: 'baseUrl', value: 'https://API.local', sensitive: false },
          { id: 'var-2', name: 'apiToken', value: 'super-secret', sensitive: true },
          { id: 'var-3', name: 'timeout', value: '30', sensitive: false },
        ],
      },
      {
        id: 'env-2',
        name: 'Staging',
        variables: [{ id: 'var-4', name: 'region', value: 'us-east', sensitive: false }],
      },
    ]

    const panel = (overrides: Partial<Parameters<typeof EnvironmentsPanel>[0]> = {}) => (
      <EnvironmentsPanel
        environments={environments}
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
        {...overrides}
      />
    )

    const searchInput = () => screen.getByRole('textbox', { name: 'Buscar variáveis do ambiente' })
    const search = (query: string) => fireEvent.change(searchInput(), { target: { value: query } })
    const visibleNames = () =>
      screen.queryAllByRole('textbox', { name: 'Nome da variável' }).map((input) => (input as HTMLInputElement).value)

    it('shows every variable while the query is empty', () => {
      render(panel())

      expect(searchInput()).toHaveValue('')
      expect(visibleNames()).toEqual(['baseUrl', 'apiToken', 'timeout'])
    })

    it('filters by name and non-sensitive value, ignoring case', () => {
      render(panel())

      search('API')
      expect(visibleNames()).toEqual(['baseUrl', 'apiToken'])

      search('  30 ')
      expect(visibleNames()).toEqual(['timeout'])
    })

    it('never matches the value of a sensitive variable', () => {
      render(panel())

      search('super-secret')
      expect(visibleNames()).toEqual([])
      expect(screen.getByText('Nenhuma variável encontrada.')).toBeInTheDocument()
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
    })

    it('clears the query with Esc and with the clear button', () => {
      render(panel())

      search('timeout')
      fireEvent.keyDown(searchInput(), { key: 'Escape' })
      expect(searchInput()).toHaveValue('')
      expect(visibleNames()).toEqual(['baseUrl', 'apiToken', 'timeout'])

      search('timeout')
      fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }))
      expect(searchInput()).toHaveValue('')
      expect(searchInput()).toHaveFocus()
      expect(visibleNames()).toEqual(['baseUrl', 'apiToken', 'timeout'])
    })

    it('edits and removes the filtered variable by id, keeping an edited row visible', () => {
      const onUpdateVariable = vi.fn()
      const onRemoveVariable = vi.fn()
      const { rerender } = render(panel({ onUpdateVariable, onRemoveVariable }))

      search('timeout')
      fireEvent.change(screen.getByRole('textbox', { name: 'Nome da variável' }), { target: { value: 'delay' } })
      expect(onUpdateVariable).toHaveBeenCalledWith('env-1', 'var-3', { name: 'delay' })

      // The renamed row no longer matches, but stays in view while it is being edited.
      const renamed = environments.map((environment) =>
        environment.id === 'env-1'
          ? {
              ...environment,
              variables: environment.variables.map((variable) =>
                variable.id === 'var-3' ? { ...variable, name: 'delay' } : variable,
              ),
            }
          : environment,
      )
      rerender(panel({ environments: renamed, onUpdateVariable, onRemoveVariable }))
      expect(visibleNames()).toEqual(['delay'])

      fireEvent.click(screen.getByRole('button', { name: 'Remover variável delay' }))
      expect(onRemoveVariable).toHaveBeenCalledWith('env-1', 'var-3')
    })

    it('disables reordering while filtering and explains why', () => {
      const onMoveVariable = vi.fn()
      render(panel({ onMoveVariable }))

      search('a')
      const grip = screen.getByRole('button', { name: 'Reordenar variável baseUrl' })
      expect(grip).toBeDisabled()
      expect(grip).toHaveAccessibleDescription('Limpe a busca para reordenar')
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(onMoveVariable).not.toHaveBeenCalled()

      fireEvent.keyDown(searchInput(), { key: 'Escape' })
      expect(screen.getByRole('button', { name: 'Reordenar variável baseUrl' })).toBeEnabled()
    })

    it('clears the query when adding a variable so the new row is visible', () => {
      const onAddVariable = vi.fn()
      render(panel({ onAddVariable }))

      search('timeout')
      fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))
      expect(onAddVariable).toHaveBeenCalledWith('env-1')
      expect(searchInput()).toHaveValue('')
      expect(visibleNames()).toEqual(['baseUrl', 'apiToken', 'timeout'])
    })

    it('does not apply to bulk editing', () => {
      render(panel())

      search('timeout')
      fireEvent.click(screen.getByRole('button', { name: 'Edição em massa' }))
      expect(screen.getByRole('button', { name: 'Edição em massa' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.queryByRole('textbox', { name: 'Buscar variáveis do ambiente' })).not.toBeInTheDocument()
      const bulkText = (screen.getByRole('textbox', { name: 'Variáveis em massa' }) as HTMLTextAreaElement).value
      expect(bulkText).toContain('baseUrl')
      expect(bulkText).toContain('timeout')
      expect(bulkText).not.toContain('super-secret')

      fireEvent.click(screen.getByRole('button', { name: 'Edição em massa' }))
      expect(screen.getByRole('button', { name: 'Edição em massa' })).toHaveAttribute('aria-pressed', 'false')
      expect(searchInput()).toHaveValue('')
      expect(visibleNames()).toEqual(['baseUrl', 'apiToken', 'timeout'])
    })

    it('resets the query when another environment is opened', () => {
      const { rerender } = render(panel())

      search('timeout')
      rerender(panel({ activeEnvironmentId: 'env-2' }))
      expect(searchInput()).toHaveValue('')
      expect(visibleNames()).toEqual(['region'])

      rerender(panel({ activeEnvironmentId: 'env-1' }))
      expect(searchInput()).toHaveValue('')
      expect(visibleNames()).toEqual(['baseUrl', 'apiToken', 'timeout'])
    })

    it('hides the search when the environment has no variables', () => {
      render(panel({ environments: [{ id: 'env-1', name: 'Local', variables: [] }] }))

      expect(screen.queryByRole('textbox', { name: 'Buscar variáveis do ambiente' })).not.toBeInTheDocument()
    })
  })
})
