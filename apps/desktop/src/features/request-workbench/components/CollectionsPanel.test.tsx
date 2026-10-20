import { useState, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import { allFolderIds, emptyGrpcCall, type RequestContent, type RequestSummary, type TreeNode } from '../collection-tree'
import { CollectionsPanel } from './CollectionsPanel'

const emptyContent = (): RequestContent => ({
  protocol: 'graphql',
  endpointUrl: '{{baseUrl}}/graphql',
  query: '',
  variables: '{}',
  method: 'post',
  body: { type: 'raw', content: '', rawLanguage: 'json' },
  preRequestScript: '',
  postResponseScript: '',
  headers: [],
  authentication: { type: 'none' },
  routeParams: [],
  grpc: emptyGrpcCall,
})

const request = (id: string, name: string): RequestSummary => ({ id, name, protocol: 'graphql', content: emptyContent() })

const node = (id: string, name: string, folders: TreeNode[] = [], requests: RequestSummary[] = []): TreeNode => ({
  id,
  name,
  folders,
  requests,
  authentication: { type: 'inherit' },
  variables: [],
})

const noop = () => {}

function panelProps(
  collections: TreeNode[],
  changeMarkers: Map<string, 'added' | 'modified' | 'deleted'>,
  expandedIds: Set<string>,
  onRunCollection: (id: string) => void = noop,
  onGenerateFlow: (id: string) => void = noop,
  overrides: Partial<ComponentProps<typeof CollectionsPanel>> = {},
): ComponentProps<typeof CollectionsPanel> {
  return {
    collections,
    expandedIds,
    openRequestId: null,
    changeMarkers,
    onToggleExpanded: noop,
    onCollapseAll: noop,
    onExpandAll: noop,
    onRevealRequest: noop,
    onAddCollection: () => '',
    onAddFolder: () => '',
    onAddRequest: () => ({ id: '', name: '' }),
    onCreateStandaloneRequest: noop,
    onOpenRequest: noop,
    onPinRequest: noop,
    onRename: noop,
    onUpdateAuthentication: noop,
    onUpdateVariables: noop,
    favoriteIds: new Set(),
    onSetFavorites: noop,
    onAssignLabel: noop,
    onRenameLabel: noop,
    onRecolorLabel: noop,
    onRemoveLabel: noop,
    onRemove: noop,
    onRemoveMany: noop,
    onMoveMany: noop,
    onDuplicateRequest: () => ({ id: '', name: '', content: emptyContent() }),
    onMoveRequest: noop,
    onReorderRequest: noop,
    onMoveFolder: noop,
    onReorderFolder: noop,
    onReorderCollections: noop,
    onSortChildren: noop,
    onExportCollection: noop,
    onExportCollections: noop,
    onRunCollection,
    onGenerateFlow,
    onExportWebclient: noop,
    onDropOnFlow: noop,
    onExportAll: vi.fn(),
    onPrepareImportFromPath: vi.fn(),
    onPrepareImportFromUrl: vi.fn(),
    onPrepareImportFromText: vi.fn(),
    onCommitPreparedImport: vi.fn(),
    importEnvironmentTargets: [],
    environmentVariables: [],
    ...overrides,
  }
}

function renderPanel(
  collections: TreeNode[],
  changeMarkers: Map<string, 'added' | 'modified' | 'deleted'>,
  expandedIds: Set<string>,
  onRunCollection: (id: string) => void = noop,
  onGenerateFlow: (id: string) => void = noop,
  overrides: Partial<ComponentProps<typeof CollectionsPanel>> = {},
) {
  return render(<CollectionsPanel {...panelProps(collections, changeMarkers, expandedIds, onRunCollection, onGenerateFlow, overrides)} />)
}

describe('CollectionsPanel — marcas de alteração', () => {
  it('mostra a letra de alteração e colore o nome da requisição que mudou', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users')])]
    renderPanel(collections, new Map([['r1', 'modified']]), new Set(['c1']))

    expect(screen.getByText('M')).toBeInTheDocument()
    expect(screen.getByText('List users')).toHaveAttribute('data-change-kind', 'modified')
  })

  it('propaga uma bolinha (sem letra) até a pasta e a coleção que não mudaram elas mesmas', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]
    renderPanel(collections, new Map([['r1', 'added']]), new Set(['c1', 'f1']))

    // The request has its own letter marker.
    expect(screen.getByText('A')).toBeInTheDocument()
    // Ancestor folders and collections only show a dot with a translated aria-label.
    expect(screen.getAllByLabelText('Contém alterações não enviadas')).toHaveLength(2)
    expect(screen.getByText('Orders')).toHaveAttribute('data-change-kind', 'added')
    expect(screen.getByText('Customer API')).toHaveAttribute('data-change-kind', 'added')
  })

  it('quando a própria pasta foi adicionada, mostra a letra nela (não a bolinha) e propaga a bolinha só até a coleção', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]
    renderPanel(collections, new Map([['f1', 'added']]), new Set(['c1', 'f1']))

    expect(screen.getByText('A')).toBeInTheDocument()
    // Only the unchanged collection gets a dot; the folder has its own letter marker.
    expect(screen.getAllByLabelText('Contém alterações não enviadas')).toHaveLength(1)
    expect(screen.getByText('Customer API')).toHaveAttribute('data-change-kind', 'added')
  })

  it('não mostra nenhuma marca quando não há alterações', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users')])]
    renderPanel(collections, new Map(), new Set(['c1']))

    expect(screen.queryByText('M')).not.toBeInTheDocument()
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(screen.queryByText('D')).not.toBeInTheDocument()
    expect(screen.getByText('List users')).not.toHaveAttribute('data-change-kind')
  })
})

describe('CollectionsPanel — expandir e recolher tudo', () => {
  it('expande collections e subpastas recursivamente e volta a recolhê-las no mesmo botão', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [node('f2', 'Recent', [], [request('r1', 'List orders')])])])]

    function ControlledPanel() {
      const [expandedIds, setExpandedIds] = useState(new Set<string>())
      return (
        <CollectionsPanel
          {...panelProps(collections, new Map(), expandedIds, noop, noop, {
            onExpandAll: () => setExpandedIds(allFolderIds(collections)),
            onCollapseAll: () => setExpandedIds(new Set()),
          })}
        />
      )
    }

    render(<ControlledPanel />)
    expect(screen.queryByText('List orders')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expandir tudo' }))
    expect(screen.getByRole('button', { name: 'Recolher tudo' })).toBeInTheDocument()
    expect(screen.getByText('List orders')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Recolher tudo' }))
    expect(screen.getByRole('button', { name: 'Expandir tudo' })).toBeInTheDocument()
    expect(screen.queryByText('List orders')).not.toBeInTheDocument()
  })

  it('recolher ou clicar numa coleção vazia tira o foco da linha; expandir mantém', () => {
    const onToggleExpanded = vi.fn()
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'List users')]),
      node('c2', 'Billing', [], [request('r2', 'Invoice')]),
      node('c3', 'Empty'),
    ]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onToggleExpanded })
    const clickFocused = (name: string) => {
      const row = screen.getByText(name).closest('.collections-row') as HTMLElement
      row.focus()
      fireEvent.click(row)
      return row
    }

    expect(clickFocused('Customer API')).not.toHaveFocus()
    expect(clickFocused('Billing')).toHaveFocus()
    expect(clickFocused('Empty')).not.toHaveFocus()
    expect(onToggleExpanded.mock.calls).toEqual([['c1'], ['c2']])
  })

  it('durante a busca, recolhe pastas dos resultados sem mexer na expansão salva e reabre ao mudar o texto', () => {
    const onToggleExpanded = vi.fn()
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]
    renderPanel(collections, new Map(), new Set(), noop, noop, { onToggleExpanded })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar requisições' }))
    const search = screen.getByRole('textbox', { name: 'Buscar requisições...' })
    fireEvent.change(search, { target: { value: 'orders' } })
    expect(screen.getByText('List orders')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Orders').closest('.collections-row') as HTMLElement)
    expect(screen.queryByText('List orders')).not.toBeInTheDocument()
    expect(screen.getByText('Orders')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Orders').closest('.collections-row') as HTMLElement)
    expect(screen.getByText('List orders')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Customer API').closest('.collections-row') as HTMLElement)
    expect(screen.queryByText('Orders')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'list' } })
    expect(screen.getByText('List orders')).toBeInTheDocument()
    expect(onToggleExpanded).not.toHaveBeenCalled()
  })
})

describe('CollectionsPanel — alphabetical sorting', () => {
  it('offers sorting only in collection and folder context menus and alternates direction', () => {
    const onSortChildren = vi.fn()
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onSortChildren })
    const customerRow = screen.getByText('Customer API').closest('.collections-row') as HTMLElement
    const ordersRow = screen.getByText('Orders').closest('.collections-row') as HTMLElement

    expect(screen.queryByRole('button', { name: /Ordenar conteúdo/ })).not.toBeInTheDocument()

    fireEvent.contextMenu(customerRow)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ordenar conteúdo de A a Z' }))
    expect(onSortChildren).toHaveBeenCalledWith('c1', 'ascending')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(customerRow)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ordenar conteúdo de Z a A' }))
    expect(onSortChildren).toHaveBeenLastCalledWith('c1', 'descending')

    fireEvent.click(within(ordersRow).getByRole('button', { name: 'Mais opções de Orders' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ordenar conteúdo de A a Z' }))
    expect(onSortChildren).toHaveBeenLastCalledWith('f1', 'ascending')
  })
})

describe('CollectionsPanel — runner', () => {
  it('abre o runner da pasta pelo menu de contexto', () => {
    const onRunCollection = vi.fn()
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]
    renderPanel(collections, new Map(), new Set(['c1']), onRunCollection)

    fireEvent.contextMenu(screen.getByText('Orders'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Executar...' }))

    expect(onRunCollection).toHaveBeenCalledWith('f1')
  })

  it('também oferece o runner no menu da coleção', () => {
    const onRunCollection = vi.fn()
    renderPanel([node('c1', 'Customer API')], new Map(), new Set(), onRunCollection)

    fireEvent.contextMenu(screen.getByText('Customer API'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Executar...' }))

    expect(onRunCollection).toHaveBeenCalledWith('c1')
  })
})

describe('CollectionsPanel — gerar flow', () => {
  it('gera um flow a partir de uma requisição', () => {
    const onGenerateFlow = vi.fn()
    renderPanel([node('c1', 'Customer API', [], [request('r1', 'List users')])], new Map(), new Set(['c1']), noop, onGenerateFlow)

    fireEvent.contextMenu(screen.getByText('List users'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Gerar flow' }))

    expect(onGenerateFlow).toHaveBeenCalledWith('r1')
  })

  it('gera um flow a partir de uma pasta com requisições em subpastas', () => {
    const onGenerateFlow = vi.fn()
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [node('f2', 'Old', [], [request('r1', 'List')])])])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, onGenerateFlow)

    fireEvent.contextMenu(screen.getByText('Orders'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Gerar flow' }))

    expect(onGenerateFlow).toHaveBeenCalledWith('f1')
  })

  it('desabilita a opção numa pasta sem requisições', () => {
    renderPanel([node('c1', 'Customer API')], new Map(), new Set())

    fireEvent.contextMenu(screen.getByText('Customer API'))

    expect(screen.getByRole('menuitem', { name: 'Gerar flow' })).toBeDisabled()
  })
})

describe('CollectionsPanel — exportar', () => {
  it('abre as formas de exportar numa coleção', () => {
    const onExportCollection = vi.fn()
    const onExportWebclient = vi.fn()
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List')])]
    renderPanel(collections, new Map(), new Set(), noop, noop, { onExportCollection, onExportWebclient })

    fireEvent.contextMenu(screen.getByText('Customer API'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
    expect(screen.queryByRole('menuitem', { name: 'Remover' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Formato Alcy' }))
    expect(onExportCollection).toHaveBeenCalledWith('c1')

    fireEvent.contextMenu(screen.getByText('Customer API'))
    expect(screen.getByRole('menuitem', { name: 'Remover' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Como webclient' }))
    expect(onExportWebclient).toHaveBeenCalledWith('c1')
  })

  it('numa pasta, oferece só o webclient', () => {
    const onExportWebclient = vi.fn()
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List')])])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onExportWebclient })

    fireEvent.contextMenu(screen.getByText('Orders'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))

    expect(screen.queryByRole('menuitem', { name: 'Formato Alcy' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Como webclient' }))
    expect(onExportWebclient).toHaveBeenCalledWith('f1')
  })

  it('sem requisições, desabilita o webclient (e a exportação de uma pasta)', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Empty')])]
    renderPanel(collections, new Map(), new Set(['c1']))

    fireEvent.contextMenu(screen.getByText('Empty'))
    expect(screen.getByRole('menuitem', { name: 'Exportar' })).toBeDisabled()

    fireEvent.contextMenu(screen.getByText('Customer API'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
    expect(screen.getByRole('menuitem', { name: 'Como webclient' })).toBeDisabled()
  })
})

describe('CollectionsPanel — seleção múltipla', () => {
  const rowOf = (name: string) => screen.getByText(name).closest('.collections-row') as HTMLElement
  const selectionBar = () => screen.getByRole('toolbar', { name: 'Ações da seleção' })

  it('Ctrl+clique seleciona a requisição sem abri-la', () => {
    const onOpenRequest = vi.fn()
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users'), request('r2', 'Get user')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onOpenRequest })

    fireEvent.click(screen.getByText('List users'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Get user'), { metaKey: true })

    expect(onOpenRequest).not.toHaveBeenCalled()
    expect(rowOf('List users')).toHaveClass('collections-row--selected')
    expect(rowOf('Get user')).toHaveClass('collections-row--selected')
    expect(within(selectionBar()).getByText('2 selecionados')).toBeInTheDocument()

    fireEvent.click(screen.getByText('List users'), { ctrlKey: true })
    expect(rowOf('List users')).not.toHaveClass('collections-row--selected')
  })

  it('Ctrl+clique liga o modo seleção: mostra os checkboxes e o clique simples alterna sem limpar', () => {
    const onOpenRequest = vi.fn()
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users'), request('r2', 'Get user')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onOpenRequest })

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('List users'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Get user'), { ctrlKey: true })
    expect(screen.getByRole('checkbox', { name: 'Selecionar List users' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Selecionar Get user' })).toBeChecked()

    fireEvent.click(screen.getByText('List users'))
    expect(onOpenRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: 'Selecionar List users' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Selecionar Get user' })).toBeChecked()

    fireEvent.keyDown(rowOf('Get user'), { key: 'Escape' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('Shift+clique seleciona o intervalo de linhas visíveis a partir do último clique', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Closed', [], [request('hidden', 'Hidden')])], [
        request('r1', 'First'),
        request('r2', 'Second'),
      ]),
    ]
    renderPanel(collections, new Map(), new Set(['c1']))

    fireEvent.click(screen.getByText('Customer API'))
    fireEvent.click(screen.getByText('Second'), { shiftKey: true })

    // Selected rows: Customer API, Closed (collapsed, including its child), First, Second.
    // The count reflects action targets: the collection already includes the rest.
    expect(within(selectionBar()).getByText('1 selecionado')).toBeInTheDocument()
    expect(rowOf('Customer API')).toHaveClass('collections-row--selected')
    expect(rowOf('Closed')).toHaveClass('collections-row--selected')
    expect(rowOf('Second')).toHaveClass('collections-row--selected')
  })

  it('linhas selecionadas vizinhas se juntam num bloco só, mesmo entre níveis da árvore', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])], [
        request('r2', 'Get user'),
        request('r3', 'Delete user'),
      ]),
    ]
    renderPanel(collections, new Map(), new Set(['c1', 'f1']))

    fireEvent.click(screen.getByText('Orders'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Delete user'), { ctrlKey: true })

    expect(rowOf('Orders')).toHaveClass('collections-row--joined-below')
    expect(rowOf('Orders')).not.toHaveClass('collections-row--joined-above')
    expect(rowOf('List orders')).toHaveClass('collections-row--joined-above')
    expect(rowOf('List orders')).not.toHaveClass('collections-row--joined-below')
    expect(rowOf('Delete user')).not.toHaveClass('collections-row--joined-above')
  })

  it('marcar uma coleção ou pasta marca todo o conteúdo; desmarcar um filho desmarca os ancestrais', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])], [request('r2', 'Get user')]),
    ]
    renderPanel(collections, new Map(), new Set(['c1', 'f1']))
    const checkbox = (name: string) => screen.getByRole('checkbox', { name: `Selecionar ${name}` })

    fireEvent.click(screen.getByText('Orders'), { ctrlKey: true })
    expect(checkbox('Orders')).toBeChecked()
    expect(checkbox('List orders')).toBeChecked()
    expect(checkbox('Get user')).not.toBeChecked()

    fireEvent.click(screen.getByText('Customer API'))
    for (const name of ['Customer API', 'Orders', 'List orders', 'Get user']) expect(checkbox(name)).toBeChecked()
    expect(within(selectionBar()).getByText('1 selecionado')).toBeInTheDocument()

    fireEvent.click(screen.getByText('List orders'))
    expect(checkbox('List orders')).not.toBeChecked()
    expect(checkbox('Orders')).not.toBeChecked()
    expect(checkbox('Customer API')).not.toBeChecked()
    expect(checkbox('Get user')).toBeChecked()
    expect(within(selectionBar()).getByText('1 selecionado')).toBeInTheDocument()
  })

  it('clique simples, fora do modo seleção, limpa a seleção e segue abrindo a requisição', () => {
    const onOpenRequest = vi.fn()
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users'), request('r2', 'Get user')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onOpenRequest })

    fireEvent.click(screen.getByText('List users'), { ctrlKey: true })
    fireEvent.keyDown(rowOf('List users'), { key: 'Escape' })
    fireEvent.click(screen.getByText('Get user'))

    expect(onOpenRequest).toHaveBeenCalledWith('r2', expect.anything(), 'Get user')
    expect(screen.queryByRole('toolbar', { name: 'Ações da seleção' })).not.toBeInTheDocument()
  })

  it('duplo clique na requisição pede para fixar a aba', () => {
    const onPinRequest = vi.fn()
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users'), request('r2', 'Get user')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onPinRequest })

    fireEvent.doubleClick(screen.getByText('List users'))
    expect(onPinRequest).toHaveBeenCalledWith('r1')
  })

  it('"Selecionar" no menu de contexto liga o modo seleção com o item marcado; o clique alterna e Esc sai', () => {
    const onOpenRequest = vi.fn()
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'List users')]),
      node('c2', 'Billing', [], [request('r2', 'Invoice')]),
    ]
    renderPanel(collections, new Map(), new Set(['c1', 'c2']), noop, noop, { onOpenRequest })

    fireEvent.contextMenu(screen.getByText('Customer API'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Selecionar' }))
    expect(screen.getByRole('checkbox', { name: 'Selecionar Customer API' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Selecionar List users' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Selecionar Invoice' })).not.toBeChecked()

    fireEvent.click(screen.getByText('Invoice'))
    expect(onOpenRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: 'Selecionar Invoice' })).toBeChecked()

    fireEvent.keyDown(rowOf('Invoice'), { key: 'Escape' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('toolbar', { name: 'Ações da seleção' })).not.toBeInTheDocument()
  })

  it('remove em lote com uma confirmação, ignorando itens dentro de pastas selecionadas', () => {
    const onRemoveMany = vi.fn()
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])], [request('r2', 'Get user')]),
    ]
    renderPanel(collections, new Map(), new Set(['c1', 'f1']), noop, noop, { onRemoveMany })

    fireEvent.click(screen.getByText('List orders'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Orders'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Get user'), { ctrlKey: true })
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Remover' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Remover 2 itens?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }))

    expect(onRemoveMany).toHaveBeenCalledWith(['f1', 'r2'])
  })

  it('move em lote sem oferecer a própria pasta selecionada como destino', () => {
    const onMoveMany = vi.fn()
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Orders', [node('f2', 'Old')])], [request('r1', 'Get user')]),
      node('c2', 'Billing'),
    ]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onMoveMany })

    fireEvent.click(screen.getByText('Orders'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Get user'), { ctrlKey: true })
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Mover' }))

    const dialog = screen.getByRole('dialog')
    const destinations = () =>
      within(within(dialog).getByRole('list', { name: 'Collections e pastas' }))
        .queryAllByRole('button')
        .map((button) => button.textContent)
    expect(destinations()).toEqual(['Customer API', 'Billing'])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Customer API' }))
    expect(destinations()).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voltar' }))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Billing' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }))

    expect(onMoveMany).toHaveBeenCalledWith(['f1', 'r1'], 'c2')
  })

  it('não move uma seleção com coleção', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Get user')])]
    renderPanel(collections, new Map(), new Set(['c1']))

    fireEvent.click(screen.getByText('Customer API'), { ctrlKey: true })

    expect(within(selectionBar()).getByRole('button', { name: 'Mover' })).toBeDisabled()
  })

  it('exporta em lote só quando todos os selecionados são coleções', () => {
    const onExportCollections = vi.fn()
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Get user')]), node('c2', 'Billing')]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onExportCollections })

    fireEvent.click(screen.getByText('Customer API'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Billing'), { ctrlKey: true })
    fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Exportar' }))
    expect(onExportCollections).toHaveBeenCalledWith(['c1', 'c2'])

    fireEvent.click(screen.getByText('Billing'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Customer API'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Get user'), { ctrlKey: true })
    expect(within(selectionBar()).getByRole('button', { name: 'Exportar' })).toBeDisabled()
  })
})

describe('CollectionsPanel — atalhos do item focado', () => {
  const rowOf = (name: string) => screen.getByText(name).closest('.collections-row') as HTMLElement

  it('Ctrl+D duplica a requisição focada e abre a cópia', () => {
    const onOpenRequest = vi.fn()
    const onDuplicateRequest = vi.fn(() => ({ id: 'r1-copy', name: 'List users (cópia)', content: emptyContent() }))
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onOpenRequest, onDuplicateRequest })

    fireEvent.keyDown(rowOf('List users'), { key: 'd', ctrlKey: true })

    expect(onDuplicateRequest).toHaveBeenCalledWith('r1')
    expect(onOpenRequest).toHaveBeenCalledWith('r1-copy', expect.anything(), 'List users (cópia)')
  })

  it('Delete pede confirmação para requisição, pasta e collection', () => {
    const onRemove = vi.fn()
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders')], [request('r1', 'List users')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onRemove })

    fireEvent.keyDown(rowOf('List users'), { key: 'Delete' })
    expect(within(screen.getByRole('dialog')).getByText('Remover requisição?')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remover' }))
    expect(onRemove).toHaveBeenCalledWith('r1')

    fireEvent.keyDown(rowOf('Customer API'), { key: 'Delete' })
    expect(within(screen.getByRole('dialog')).getByText('Excluir “Customer API”?')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Excluir Collection' })).toBeDisabled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }))

    fireEvent.keyDown(rowOf('Orders'), { key: 'Delete' })
    expect(onRemove).toHaveBeenCalledTimes(1)
    const folderDialog = screen.getByRole('dialog')
    expect(within(folderDialog).getByText('Excluir pasta?')).toBeInTheDocument()
    expect(within(folderDialog).getByText(/a pasta "Orders"\? Itens afetados: 0 pastas e 0 requisições/)).toBeInTheDocument()
    fireEvent.click(within(folderDialog).getByRole('button', { name: 'Remover' }))
    expect(onRemove).toHaveBeenLastCalledWith('f1')
    expect(onRemove).toHaveBeenCalledTimes(2)
  })

  it('Delete numa linha da seleção múltipla remove a seleção com uma confirmação', () => {
    const onRemoveMany = vi.fn()
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users'), request('r2', 'Get user')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onRemoveMany })

    fireEvent.click(screen.getByText('List users'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Get user'), { ctrlKey: true })
    fireEvent.keyDown(rowOf('Get user'), { key: 'Delete' })

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Remover 2 itens?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }))
    expect(onRemoveMany).toHaveBeenCalledWith(['r1', 'r2'])
  })

  it('não age com o foco no campo de nome aberto', () => {
    const onRemove = vi.fn()
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { onRemove })

    fireEvent.keyDown(rowOf('Orders'), { key: 'F2' })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome' }), { key: 'Delete' })

    expect(onRemove).not.toHaveBeenCalled()
  })
})

describe('CollectionsPanel — comandos de atalho', () => {
  it('abre a importação e avisa que tratou o comando', async () => {
    const onCommandHandled = vi.fn()
    renderPanel([node('c1', 'Customer API')], new Map(), new Set(), noop, noop, {
      command: { kind: 'import' },
      onCommandHandled,
    })

    expect(within(await screen.findByRole('dialog')).getByText('Importar Collection')).toBeInTheDocument()
    expect(onCommandHandled).toHaveBeenCalled()
  })

  it('abre e foca a busca', () => {
    renderPanel([node('c1', 'Customer API')], new Map(), new Set(), noop, noop, { command: { kind: 'search' } })

    expect(screen.getByRole('textbox', { name: 'Buscar requisições...' })).toHaveFocus()
  })

  it('põe a collection criada pelo atalho em modo de renomear', () => {
    renderPanel([node('c1', 'Customer API'), node('c2', 'Nova Collection')], new Map(), new Set(), noop, noop, {
      command: { kind: 'rename', id: 'c2' },
    })

    expect(screen.getByRole('textbox', { name: 'Nome' })).toHaveValue('Nova Collection')
  })

  it('não repete o comando já tratado ao remontar', () => {
    const props = panelProps([node('c1', 'Customer API')], new Map(), new Set(), noop, noop, { command: { kind: 'import' } })
    const { unmount } = render(<CollectionsPanel {...props} />)
    unmount()
    render(<CollectionsPanel {...props} command={null} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('CollectionsPanel — rótulos e favoritas', () => {
  const labeled = (id: string, name: string, labels: TreeNode['labels'], requests: RequestSummary[] = []): TreeNode => ({
    ...node(id, name, [], requests),
    labels,
  })
  const collectionNames = () =>
    Array.from(document.querySelectorAll('.collections-row--collection .collections-node-name')).map((element) => element.textContent)
  const openFilterMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Filtrar collections' }))

  const collections = [
    labeled('c1', 'Pedidos', [{ name: 'Pagamentos', color: 'green' }], [request('r1', 'Listar pedidos')]),
    labeled('c2', 'Usuários', [{ name: 'Legado', color: 'gray' }], [request('r2', 'Listar usuários')]),
    node('c3', 'Catálogo'),
  ]

  it('mostra as favoritas primeiro e alterna a estrela da collection', () => {
    const onSetFavorites = vi.fn()
    renderPanel(collections, new Map(), new Set(), noop, noop, { favoriteIds: new Set(['c3']), onSetFavorites })

    expect(collectionNames()).toEqual(['Catálogo', 'Pedidos', 'Usuários'])
    const favoriteStar = screen.getByRole('button', { name: 'Remover "Catálogo" dos favoritos' })
    expect(favoriteStar).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Favoritar "Pedidos"' }))
    expect(onSetFavorites).toHaveBeenCalledWith(['c1'], true, ['c1', 'c2', 'c3'])

    fireEvent.click(favoriteStar)
    expect(onSetFavorites).toHaveBeenLastCalledWith(['c3'], false, ['c1', 'c2', 'c3'])
  })

  it('oferece favoritar e rótulos só no menu de collections', () => {
    const onSetFavorites = vi.fn()
    renderPanel([node('c1', 'API', [node('f1', 'Pasta')])], new Map(), new Set(['c1']), noop, noop, { onSetFavorites })

    fireEvent.contextMenu(screen.getByText('Pasta'))
    expect(screen.queryByRole('menuitem', { name: 'Favoritar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Rótulos...' })).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByText('API'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Favoritar' }))
    expect(onSetFavorites).toHaveBeenCalledWith(['c1'], true, ['c1'])
  })

  it('mostra as cores dos rótulos na linha da collection', () => {
    renderPanel(collections, new Map(), new Set())

    expect(screen.getByRole('img', { name: 'Rótulos: Pagamentos' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Rótulos: Legado' })).toBeInTheDocument()
  })

  it('filtra só pelas favoritas', () => {
    renderPanel(collections, new Map(), new Set(), noop, noop, { favoriteIds: new Set(['c2']) })

    openFilterMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Somente favoritas' }))

    expect(collectionNames()).toEqual(['Usuários'])
    expect(screen.getByRole('group', { name: 'Filtros ativos' })).toHaveTextContent('Favoritas')
  })

  it('filtra por rótulos sem texto na busca e remove o filtro pelo chip', () => {
    renderPanel(collections, new Map(), new Set())

    openFilterMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Pagamentos' }))
    expect(collectionNames()).toEqual(['Pedidos'])

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Legado' }))
    expect(collectionNames()).toEqual(['Pedidos', 'Usuários'])

    fireEvent.click(screen.getByRole('button', { name: 'Remover filtro "Pagamentos"' }))
    expect(collectionNames()).toEqual(['Usuários'])

    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }))
    expect(collectionNames()).toEqual(['Pedidos', 'Usuários', 'Catálogo'])
    expect(screen.queryByRole('group', { name: 'Filtros ativos' })).not.toBeInTheDocument()
  })

  it('combina os filtros com o texto da busca e mostra o estado vazio dos filtros', () => {
    renderPanel(collections, new Map(), new Set())

    openFilterMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Pagamentos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Buscar requisições' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar requisições...' }), { target: { value: 'usuários' } })
    expect(screen.getByText('Nenhuma requisição encontrada.')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar requisições...' }), { target: { value: 'pedidos' } })
    expect(collectionNames()).toEqual(['Pedidos'])

    fireEvent.click(screen.getByRole('button', { name: 'Fechar busca' }))
    openFilterMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Somente favoritas' }))
    expect(screen.getByText('Nenhuma collection corresponde aos filtros.')).toBeInTheDocument()
  })

  it('abre o modal de rótulos da collection e liga um rótulo existente', () => {
    const onAssignLabel = vi.fn()
    renderPanel(collections, new Map(), new Set(), noop, noop, { onAssignLabel })

    fireEvent.contextMenu(screen.getByText('Catálogo'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rótulos...' }))
    const dialog = screen.getByRole('dialog', { name: 'Rótulos de "Catálogo"' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Legado' }))

    expect(onAssignLabel).toHaveBeenCalledWith(['c3'], { name: 'Legado', color: 'gray' }, true)
  })

  describe('na seleção múltipla', () => {
    const selectionBar = () => screen.getByRole('toolbar', { name: 'Ações da seleção' })

    it('favorita todas as collections selecionadas e desmarca quando todas já são favoritas', () => {
      const onSetFavorites = vi.fn()
      const { rerender } = renderPanel(collections, new Map(), new Set(), noop, noop, { favoriteIds: new Set(['c1']), onSetFavorites })

      fireEvent.click(screen.getByText('Pedidos'), { ctrlKey: true })
      fireEvent.click(screen.getByText('Usuários'), { ctrlKey: true })
      fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Favoritar selecionadas' }))
      expect(onSetFavorites).toHaveBeenCalledWith(['c1', 'c2'], true, ['c1', 'c2', 'c3'])

      rerender(<CollectionsPanel {...panelProps(collections, new Map(), new Set(), noop, noop, { favoriteIds: new Set(['c1', 'c2']), onSetFavorites })} />)
      const unfavorite = within(selectionBar()).getByRole('button', { name: 'Remover selecionadas dos favoritos' })
      expect(unfavorite).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(unfavorite)
      expect(onSetFavorites).toHaveBeenLastCalledWith(['c1', 'c2'], false, ['c1', 'c2', 'c3'])
    })

    it('aplica um rótulo a todas as collections selecionadas', () => {
      const onAssignLabel = vi.fn()
      renderPanel(collections, new Map(), new Set(), noop, noop, { onAssignLabel })

      fireEvent.click(screen.getByText('Pedidos'), { ctrlKey: true })
      fireEvent.click(screen.getByText('Catálogo'), { ctrlKey: true })
      fireEvent.click(within(selectionBar()).getByRole('button', { name: 'Rótulos das selecionadas' }))
      const dialog = screen.getByRole('dialog', { name: 'Rótulos de 2 collections' })
      expect(within(dialog).getByRole('checkbox', { name: 'Pagamentos' })).toBePartiallyChecked()
      fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Pagamentos' }))

      expect(onAssignLabel).toHaveBeenCalledWith(['c1', 'c3'], { name: 'Pagamentos', color: 'green' }, true)
    })

    it('desabilita favoritar e rótulos quando a seleção tem algo além de collections', () => {
      renderPanel(collections, new Map(), new Set(['c1']))

      fireEvent.click(screen.getByText('Pedidos'), { ctrlKey: true })
      fireEvent.click(screen.getByText('Listar pedidos'), { ctrlKey: true })

      expect(within(selectionBar()).getByRole('button', { name: 'Favoritar selecionadas' })).toBeDisabled()
      expect(within(selectionBar()).getByRole('button', { name: 'Rótulos das selecionadas' })).toBeDisabled()
    })
  })
})

describe('CollectionsPanel — grupos do menu de contexto', () => {
  /** Group open menu items by separators. */
  const menuGroups = () => {
    const groups: string[][] = [[]]
    for (const element of Array.from(screen.getByRole('menu').children)) {
      if (element.getAttribute('role') === 'separator') groups.push([])
      else groups[groups.length - 1].push(element.textContent ?? '')
    }
    return groups
  }

  it('agrupa as ações da requisição por função', () => {
    renderPanel([node('c1', 'API', [], [request('r1', 'Listar')])], new Map(), new Set(['c1']))

    fireEvent.contextMenu(screen.getByText('Listar'))

    expect(menuGroups()).toEqual([['Gerar flow'], ['RenomearF2', 'DuplicarCtrl+D'], ['Mover para...', 'Selecionar'], ['RemoverDelete']])
  })

  it('agrupa as ações da collection por função, com favoritas e rótulos num grupo próprio', () => {
    renderPanel([node('c1', 'API', [node('f1', 'Pasta')], [request('r1', 'Listar')])], new Map(), new Set(['c1']))

    fireEvent.contextMenu(screen.getByText('API'))
    const collectionGroups = menuGroups()
    expect(collectionGroups[0]).toEqual(['Adicionar pasta', 'Adicionar requisição'])
    expect(collectionGroups[1]).toEqual(['Executar...', 'Gerar flow'])
    expect(collectionGroups[2]).toEqual(['Favoritar', 'Rótulos...'])
    expect(collectionGroups[3][0]).toBe('Gerenciar...')
    expect(collectionGroups.slice(-2)).toEqual([['Ordenar conteúdo de A a Z', 'RenomearF2', 'Selecionar'], ['RemoverDelete']])

    fireEvent.contextMenu(screen.getByText('Pasta'))
    expect(menuGroups().some((group) => group.includes('Favoritar'))).toBe(false)
    expect(menuGroups().every((group) => group.length > 0)).toBe(true)
  })
})

describe('CollectionsPanel — pinned toolbar', () => {
  const toolbar = () => document.querySelector('.sidebar-panel-toolbar') as HTMLElement
  const scrollBody = () => document.querySelector('.sidebar-panel-scroll') as HTMLElement

  it('keeps search, active filters and the selection bar outside the scrolling body that holds the tree', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'List users')])]
    renderPanel(collections, new Map(), new Set(['c1']), noop, noop, { favoriteIds: new Set(['c1']) })

    fireEvent.click(screen.getByRole('button', { name: 'Filtrar collections' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Somente favoritas' }))
    fireEvent.click(screen.getByRole('button', { name: 'Buscar requisições' }))
    fireEvent.click(screen.getByText('List users'), { ctrlKey: true })

    expect(toolbar()).toContainElement(screen.getByRole('textbox', { name: 'Buscar requisições...' }))
    expect(toolbar()).toContainElement(screen.getByRole('group', { name: 'Filtros ativos' }))
    expect(toolbar()).toContainElement(screen.getByRole('toolbar', { name: 'Ações da seleção' }))
    expect(toolbar()).not.toContainElement(scrollBody())
    expect(scrollBody()).toContainElement(screen.getByText('List users'))
  })

  it('renders the empty state inside the scrolling body, below the toolbar', () => {
    renderPanel([], new Map(), new Set())

    expect(toolbar()).toContainElement(screen.getByRole('button', { name: 'Buscar requisições' }))
    expect(scrollBody()).toContainElement(screen.getByText('Nenhuma Collection ainda.'))
  })
})
