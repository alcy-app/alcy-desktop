import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { DragPreview } from '../../../shared/DragPreview'
import { FEATURE_FLAGS } from '../../../shared/feature-flags'
import type { AuthenticationInput } from '../../../bindings/execute-graphql-request'
import type { ItemChangeKind } from '../../../bindings/gitlab-types'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { CollectionLabelDto, LabelColor, ScopedVariableDto } from '../../../bindings/list-collections'
import { useLanguage } from '../../../shared/i18n/use-language'
import { comboFromEvent, isShortcutFor } from '../../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../../shared/shortcuts/use-shortcuts'
import { ChangeDot, ChangeMarker } from '../../../shared/ui/ChangeMarker'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { IconButton } from '../../../shared/ui/IconButton'
import { InlineEditInput } from '../../../shared/ui/InlineEditInput'
import { MenuCheckboxItem, MenuItem, MenuSeparator, OptionsMenu } from '../../../shared/ui/Menu'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import { EmptyState } from '../../../shared/ui/EmptyState'
import {
  ChevronRightIcon,
  CheckIcon,
  AlertIcon,
  CloseIcon,
  CollapseAllIcon,
  DownloadIcon,
  ExpandAllIcon,
  FilterIcon,
  FolderIcon,
  FolderOpenIcon,
  ImportIcon,
  LocateIcon,
  PlusIcon,
  SearchIcon,
  Spinner,
  SortAscendingIcon,
  SortDescendingIcon,
  StarIcon,
  TagIcon,
  TrashIcon,
} from '../../../shared/ui/icons'
import { usePointerDrag } from '../../../shared/use-pointer-drag'
import type { DragRef, DropEdge, SiblingEdge } from '../../../shared/use-pointer-drag'
import {
  allFolderIds,
  emptyRequestContent,
  filterTree,
  findAncestorIds,
  findNode,
  findParentId,
  findRequest,
  folderSubtreeIds,
  nestedChangeKinds,
  toggleTreeSelection,
  topLevelSelection,
  variablesAboveNode,
  visibleItemIds,
  withDescendants,
} from '../collection-tree'
import type { RequestContent, RequestProtocol, RequestSummary, TreeNode } from '../collection-tree'
import type { AlphabeticalSortDirection } from '../collection-tree'
import type { ImportOutcome } from '../use-collections-state'
import {
  filterCollections,
  hasCollectionFilters,
  labelCatalog,
  labelKey,
  NO_COLLECTION_FILTERS,
  sortFavoritesFirst,
  type CollectionFilters,
} from '../collection-labels'
import { discardPreparedImport, type PrepareImportResult } from '../../../bindings/prepared-import'
import type { PreparedImportSelection } from './ImportCollectionModal'
import { CollectionLabelsModal, LabelDot } from './CollectionLabelsModal'
import { MoveRequestModal } from './MoveRequestModal'
import { NewRequestPopover } from './NewRequestPopover'
import { NodeSettingsModal } from './NodeSettingsModal'
import { RemoveNodeModal } from './RemoveNodeModal'
import { RequestMethodBadge } from './RequestMethodBadge'
import './collections-panel.css'
import './collection-labels.css'

// Só abre ao importar: fica num chunk próprio, fora da abertura do app.
const ImportCollectionModal = lazy(() => import('./ImportCollectionModal').then((module) => ({ default: module.ImportCollectionModal })))

/** `'collection'` é uma pasta no nível raiz — mesma forma que `'folder'`, tratada de forma diferente ao
 * decidir o que um arraste sobre ela significa (reordenar coleções vs. aninhar uma pasta). */
type NodeKind = 'request' | 'folder' | 'collection'

/** Alvos do arraste: linhas da árvore ou o canvas do flow aberto (spec 0095), que marca a si mesmo com
 * `data-drop-kind="flow"`. */
type DropTargetKind = NodeKind | 'flow'

/** Como destacar a linha sob o cursor durante um arraste: `'before'`/`'after'` desenham uma borda no
 * lado por onde o item entraria ao reordenar entre irmãos; `'into'` destaca a linha inteira, indicando
 * que o item seria movido para dentro dela (aninhamento), não reordenado ao lado. */
type DropIndicator = 'before' | 'after' | 'into'

/**
 * Decide o que um drop de `draggedKind` sobre `targetKind` significa dado `zone` (a metade/terço do
 * alvo sob o cursor, vindo do hook de arraste) — pastas são as únicas que suportam as duas coisas
 * dependendo de onde o cursor está (borda = reordena como irmã, meio = aninha); para os demais pares
 * válidos o resultado não depende de `zone`, é sempre uma coisa ou a outra.
 */
function resolveDrop(
  draggedKind: NodeKind,
  targetKind: NodeKind,
  zone: DropEdge,
): { indicator: DropIndicator; reorder: boolean } {
  const edge: DropIndicator = zone === 'inside' ? 'after' : zone

  if (draggedKind === 'request') {
    if (targetKind === 'request') return { indicator: edge, reorder: true }
    return { indicator: 'into', reorder: false }
  }
  if (draggedKind === 'collection') return { indicator: edge, reorder: true }
  // draggedKind === 'folder'
  if (targetKind === 'folder' && zone !== 'inside') return { indicator: edge, reorder: true }
  return { indicator: 'into', reorder: false }
}

/** Ação pedida ao painel por um atalho global: renomear a collection recém-criada,
 * abrir a importação ou focar a busca. Objeto novo a cada disparo. */
export type CollectionsCommand = { kind: 'rename'; id: string } | { kind: 'import' } | { kind: 'search' }

interface CollectionsPanelProps {
  collections: TreeNode[]
  expandedIds: Set<string>
  openRequestId: string | null
  /** Id do item (coleção/pasta/requisição) → tipo de alteração local ainda
   * não enviada, para marcar as linhas com "M"/"A"/"D". */
  changeMarkers: Map<string, ItemChangeKind>
  onToggleExpanded: (id: string) => void
  onCollapseAll: () => void
  onExpandAll: () => void
  onRevealRequest: (id: string) => void
  /** Cria uma collection (com `name`, ou o nome padrão) e devolve o id dela. */
  onAddCollection: (name?: string) => string
  /** Cria uma pasta em `parentId` (com `name`, ou o nome padrão) e devolve o id dela. */
  onAddFolder: (parentId: string, name?: string) => string
  onAddRequest: (parentId: string, name: string, protocol: RequestProtocol) => { id: string; name: string }
  /** Abre o popover de tipos para criar uma requisição avulsa (rascunho, não vinculado a nenhuma
   * coleção) — usado pelo "+" da barra de ferramentas; `anchor` é o retângulo do botão. Uma requisição
   * só passa a existir numa coleção quando o usuário salva (`SaveRequestModal`). */
  onCreateStandaloneRequest: (anchor: DOMRect) => void
  onOpenRequest: (id: string, content: RequestContent, name: string) => void
  /** Duplo clique na requisição: tira a aba do modo de pré-visualização (itálico). */
  onPinRequest: (id: string) => void
  onRename: (id: string, name: string) => void
  onUpdateAuthentication: (id: string, authentication: AuthenticationInput) => void
  onUpdateVariables: (id: string, variables: ScopedVariableDto[]) => void
  /** Collections favoritas, pessoais desta máquina (ADR 0060): aparecem primeiro. */
  favoriteIds: ReadonlySet<string>
  /** Marca/desmarca uma ou várias (seleção múltipla); `existingIds` deixa o estado das favoritas
   * descartar ids de collections removidas. */
  onSetFavorites: (ids: string[], favorite: boolean, existingIds: string[]) => void
  /** Rótulos de collection (ADR 0060): liga/desliga em uma ou várias collections e gerencia em todas. */
  onAssignLabel: (ids: string[], label: CollectionLabelDto, assigned: boolean) => void
  onRenameLabel: (oldName: string, newName: string) => void
  onRecolorLabel: (name: string, color: LabelColor) => void
  onRemoveLabel: (name: string) => void
  onRemove: (id: string) => void
  /** Remove de uma vez os itens selecionados, já normalizados (spec 0104). */
  onRemoveMany: (ids: string[]) => void
  /** Move de uma vez as pastas/requisições selecionadas para `targetParentId` (spec 0104). */
  onMoveMany: (ids: string[], targetParentId: string) => void
  onDuplicateRequest: (id: string) => { id: string; name: string; content: RequestContent }
  onMoveRequest: (id: string, targetParentId: string) => void
  onReorderRequest: (id: string, targetId: string, edge: SiblingEdge) => void
  onMoveFolder: (id: string, targetParentId: string) => void
  onReorderFolder: (id: string, targetId: string, edge: SiblingEdge) => void
  onReorderCollections: (id: string, targetId: string, edge: SiblingEdge) => void
  onSortChildren: (id: string, direction: AlphabeticalSortDirection) => void
  onExportCollection: (id: string) => void
  /** Exporta as coleções selecionadas num único arquivo (spec 0104). */
  onExportCollections: (ids: string[]) => void
  /** Abre o runner da coleção/pasta (spec 0073). */
  onRunCollection: (id: string) => void
  /** Cria um flow com as requisições do item encadeadas (spec 0095). */
  onGenerateFlow: (id: string) => void
  /** Abre o export da coleção/pasta como webclient (spec 0113). */
  onExportWebclient: (id: string) => void
  /** Itens largados sobre o canvas de um flow (um só, ou a seleção arrastada em grupo); `point` em
   * coordenadas de tela (specs 0095 e 0104). */
  onDropOnFlow: (itemIds: string[], flowId: string, point: { x: number; y: number }) => void
  onExportAll: () => void
  onPrepareImportFromPath: (path: string) => Promise<PrepareImportResult>
  onPrepareImportFromUrl: (url: string) => Promise<PrepareImportResult>
  onPrepareImportFromText: (content: string) => Promise<PrepareImportResult>
  onCommitPreparedImport: (id: string, includeDocumentation: boolean) => Promise<ImportOutcome>
  /** Variáveis do ambiente ativo — usadas pelos campos de autenticação do modal de pasta/coleção. */
  environmentVariables: EnvironmentVariableDto[]
  /** Comando pendente de um atalho; o painel o executa e avisa por `onCommandHandled`. */
  command?: CollectionsCommand | null
  onCommandHandled?: () => void
}

interface ItemShortcutHandlers {
  rename: () => void
  remove: () => void
  /** Só requisições têm "Duplicar". */
  duplicate?: () => void
}

/** Os atalhos do item (renomear, F2; duplicar, Ctrl+D; remover, Delete)
 * pressionados com foco na linha — que recebe foco ao ser clicada
 * (`tabIndex={-1}`) — ou num botão dela, mas não no campo de nome aberto. */
function useItemShortcuts({ rename, remove, duplicate }: ItemShortcutHandlers) {
  const { bindings } = useShortcuts()
  return (event: ReactKeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return
    const combo = comboFromEvent(event)
    const handler = isShortcutFor(bindings, 'renameItem', combo)
      ? rename
      : isShortcutFor(bindings, 'deleteItem', combo)
        ? remove
        : isShortcutFor(bindings, 'duplicateItem', combo)
          ? duplicate
          : undefined
    if (!handler) return
    event.preventDefault()
    handler()
  }
}

/** A pasta tem alguma requisição, em qualquer profundidade — sem isso não há o que gerar num flow. */
function containsRequest(node: TreeNode): boolean {
  return node.requests.length > 0 || node.folders.some(containsRequest)
}

function contentCounts(node: TreeNode): { folders: number; requests: number } {
  return node.folders.reduce(
    (total, folder) => {
      const nested = contentCounts(folder)
      return {
        folders: total.folders + nested.folders + 1,
        requests: total.requests + nested.requests,
      }
    },
    { folders: 0, requests: node.requests.length },
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRightIcon
      size={9}
      className={expanded ? 'collections-chevron collections-chevron--expanded' : 'collections-chevron'}
    />
  )
}

interface RequestRowProps {
  request: RequestSummary
  depth: number
  isOpen: boolean
  isDragging: boolean
  isSelected: boolean
  selectionJoin: SelectionJoin | undefined
  selectionMode: boolean
  dropIndicator: DropIndicator | null
  renamingId: string | null
  menuOpenId: string | null
  changeKind: ItemChangeKind | undefined
  onOpen: (id: string, content: RequestContent, name: string) => void
  onPin: (id: string) => void
  onStartRename: (id: string) => void
  onCommitRename: (id: string, name: string) => void
  onRemove: (id: string, kind: NodeKind, label: string) => void
  /** Remoção pelo atalho: com a linha numa seleção múltipla, remove a seleção. */
  onRemoveShortcut: (id: string, kind: NodeKind, label: string) => void
  onDuplicate: (id: string) => void
  onMove: (id: string) => void
  onGenerateFlow: (id: string) => void
  onToggleMenu: (id: string) => void
  onOpenMenu: (id: string) => void
  onCloseMenu: () => void
  onDragPointerDown: (id: string, kind: NodeKind, label: string, event: ReactPointerEvent) => void
  /** Trata o clique como seleção (modificadores ou modo seleção); `true` = consumido, sem abrir/expandir. */
  onSelectClick: (id: string, event: ReactMouseEvent) => boolean
  /** "Selecionar" do menu de contexto: liga o modo seleção com o item já marcado. */
  onStartSelection: (id: string) => void
}

/** Linha selecionada colada a outra selecionada acima/abaixo: o grupo vira um bloco só, sem cantos entre as linhas. */
interface SelectionJoin {
  above: boolean
  below: boolean
}

function pushSelectionJoinClasses(classNames: string[], join: SelectionJoin | undefined) {
  if (join?.above) classNames.push('collections-row--joined-above')
  if (join?.below) classNames.push('collections-row--joined-below')
}

/** Checkbox de linha do modo seleção — só espelha o estado; o clique sobe para a linha, que alterna. */
function RowCheckbox({ checked, label }: { checked: boolean; label: string }) {
  const { t } = useLanguage()
  return (
    <Checkbox
      className="collections-row-checkbox"
      checked={checked}
      readOnly
      tabIndex={-1}
      aria-label={t('collections.selectItemAria', { name: label })}
    />
  )
}

function RequestRow({
  request,
  depth,
  isOpen,
  isDragging,
  isSelected,
  selectionJoin,
  selectionMode,
  dropIndicator,
  renamingId,
  menuOpenId,
  changeKind,
  onOpen,
  onPin,
  onStartRename,
  onCommitRename,
  onRemove,
  onRemoveShortcut,
  onDuplicate,
  onMove,
  onGenerateFlow,
  onToggleMenu,
  onOpenMenu,
  onCloseMenu,
  onDragPointerDown,
  onSelectClick,
  onStartSelection,
}: RequestRowProps) {
  const { t } = useLanguage()
  const [draftName, setDraftName] = useState(request.name)
  const isRenaming = renamingId === request.id
  const isMenuOpen = menuOpenId === request.id
  const label = request.name || t('common.unnamed')

  const commit = () => onCommitRename(request.id, draftName)
  const startRename = () => {
    setDraftName(request.name)
    onStartRename(request.id)
    onCloseMenu()
  }
  const handleItemShortcut = useItemShortcuts({
    rename: startRename,
    remove: () => onRemoveShortcut(request.id, 'request', label),
    duplicate: () => onDuplicate(request.id),
  })

  const classNames = ['collections-row']
  if (isOpen) classNames.push('collections-row--open')
  if (isSelected) classNames.push('collections-row--selected')
  pushSelectionJoinClasses(classNames, selectionJoin)
  if (isDragging) classNames.push('collections-row--dragging')
  if (dropIndicator) classNames.push(`collections-row--drop-${dropIndicator}`)

  return (
    <li className="collections-node">
      <div
        className={classNames.join(' ')}
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
        data-drop-id={request.id}
        data-drop-kind="request"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          onDragPointerDown(request.id, 'request', label, event)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onOpenMenu(request.id)
        }}
        tabIndex={-1}
        onClick={(event) => {
          if (onSelectClick(request.id, event)) return
          onOpen(request.id, request.content, request.name)
        }}
        onDoubleClick={() => {
          if (!selectionMode) onPin(request.id)
        }}
        onKeyDown={handleItemShortcut}
      >
        {selectionMode && <RowCheckbox checked={isSelected} label={label} />}
        <RequestMethodBadge protocol={request.protocol} method={request.content.method} className="collections-method-badge" />

        {isRenaming ? (
          <InlineEditInput
            className="collections-name-input"
            value={draftName}
            autoFocus
            aria-label={t('common.name')}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commit}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
          />
        ) : (
          <span
            className="collections-node-name"
            data-change-kind={changeKind}
            aria-current={isOpen}
            aria-label={t('collections.openRequestAria', { name: label })}
          >
            {label}
          </span>
        )}

        {changeKind && <ChangeMarker kind={changeKind} />}

        <OptionsMenu
          label={t('collections.moreOptionsAria', { name: label })}
          wrapperClassName="collections-menu-wrapper"
          menuClassName="collections-menu"
          menuPlacement="auto"
          menuBoundarySelector=".env-sidebar"
          isOpen={isMenuOpen}
          onToggle={() => onToggleMenu(request.id)}
          onClose={onCloseMenu}
        >
          {/* Grupos por função, separados por divisórias: gerar, editar, organizar e, por último, remover. */}
          <MenuItem
            label={t('collections.generateFlowMenuItem')}
            onSelect={() => {
              onGenerateFlow(request.id)
              onCloseMenu()
            }}
          />
          <MenuSeparator />
          <MenuItem label={t('collections.renameMenuItem')} onSelect={startRename} />
          <MenuItem
            label={t('collections.duplicateMenuItem')}
            onSelect={() => {
              onDuplicate(request.id)
              onCloseMenu()
            }}
          />
          <MenuSeparator />
          <MenuItem
            label={t('collections.moveMenuItem')}
            onSelect={() => {
              onMove(request.id)
              onCloseMenu()
            }}
          />
          <MenuItem
            label={t('collections.selectMenuItem')}
            onSelect={() => {
              onStartSelection(request.id)
              onCloseMenu()
            }}
          />
          <MenuSeparator />
          <MenuItem
            label={t('common.remove')}
            danger
            onSelect={() => {
              onRemove(request.id, 'request', label)
              onCloseMenu()
            }}
          />
        </OptionsMenu>
      </div>
    </li>
  )
}

interface FolderRowProps {
  node: TreeNode
  depth: number
  expandedIds: Set<string>
  openRequestId: string | null
  renamingId: string | null
  menuOpenId: string | null
  changeMarkers: Map<string, ItemChangeKind>
  /** Pastas/coleções sem marca própria que contêm algo alterado — a "bolinha". */
  nestedChangeMarkers: Map<string, ItemChangeKind>
  onToggleExpanded: (id: string) => void
  onAddFolder: (parentId: string) => string
  onOpenAddRequest: (parentId: string, anchor: DOMRect) => void
  onOpenRequest: (id: string, content: RequestContent, name: string) => void
  onPinRequest: (id: string) => void
  onStartRename: (id: string) => void
  onCommitRename: (id: string, name: string) => void
  onRemove: (id: string, kind: NodeKind, label: string) => void
  onRemoveShortcut: (id: string, kind: NodeKind, label: string) => void
  onDuplicateRequest: (id: string) => void
  onMoveRequest: (id: string) => void
  onExport: (id: string) => void
  onExportWebclient: (id: string) => void
  onRun: (id: string) => void
  onGenerateFlow: (id: string) => void
  onOpenSettings: (id: string) => void
  nextSortDirectionFor: (id: string) => AlphabeticalSortDirection
  onSort: (id: string) => void
  onToggleMenu: (id: string) => void
  onOpenMenu: (id: string) => void
  onCloseMenu: () => void
  draggedId: string | null
  dragOverId: string | null
  dropIndicator: DropIndicator | null
  onDragPointerDown: (id: string, kind: NodeKind, label: string, event: ReactPointerEvent) => void
  selectedIds: ReadonlySet<string>
  selectionJoins: ReadonlyMap<string, SelectionJoin>
  selectionMode: boolean
  /** A seleção inteira está sendo arrastada (todas as linhas selecionadas ficam esmaecidas). */
  groupDragging: boolean
  onSelectClick: (id: string, event: ReactMouseEvent) => boolean
  /** "Selecionar" do menu de contexto: liga o modo seleção com o item já marcado. */
  onStartSelection: (id: string) => void
  /** Só collections (nível raiz) são favoritadas e têm rótulos. */
  isFavorite?: boolean
  onToggleFavorite?: (id: string) => void
  onOpenLabels?: (id: string) => void
}

/** Bolinhas dos rótulos depois do nome da collection; o tooltip lista os nomes. */
function CollectionLabelDots({ labels }: { labels: CollectionLabelDto[] }) {
  const { t } = useLanguage()
  const names = labels.map((label) => label.name).join(', ')
  const description = t('collections.labels.rowAria', { names })
  const tooltip = useTooltip(description)
  const visible = labels.slice(0, 3)
  return (
    <>
      <span className="collection-label-dots" role="img" aria-label={description} {...tooltip.triggerProps}>
        {visible.map((label) => (
          <LabelDot key={labelKey(label.name)} color={label.color} />
        ))}
        {labels.length > visible.length && (
          <span className="collection-label-dots-more">+{labels.length - visible.length}</span>
        )}
      </span>
      {tooltip.tooltip}
    </>
  )
}

function FolderRow({
  node,
  depth,
  expandedIds,
  openRequestId,
  renamingId,
  menuOpenId,
  changeMarkers,
  nestedChangeMarkers,
  onToggleExpanded,
  onAddFolder,
  onOpenAddRequest,
  onOpenRequest,
  onPinRequest,
  onStartRename,
  onCommitRename,
  onRemove,
  onRemoveShortcut,
  onDuplicateRequest,
  onMoveRequest,
  onExport,
  onExportWebclient,
  onRun,
  onGenerateFlow,
  onOpenSettings,
  nextSortDirectionFor,
  onSort,
  onToggleMenu,
  onOpenMenu,
  onCloseMenu,
  draggedId,
  dragOverId,
  dropIndicator,
  onDragPointerDown,
  selectedIds,
  selectionJoins,
  selectionMode,
  groupDragging,
  onSelectClick,
  onStartSelection,
  isFavorite = false,
  onToggleFavorite,
  onOpenLabels,
}: FolderRowProps) {
  const { t } = useLanguage()
  const [draftName, setDraftName] = useState(node.name)
  const rowRef = useRef<HTMLDivElement>(null)
  const hasChildren = node.folders.length > 0 || node.requests.length > 0
  const changeKind = changeMarkers.get(node.id)
  const nestedChangeKind = changeKind ? undefined : nestedChangeMarkers.get(node.id)
  const isExpanded = expandedIds.has(node.id)
  const isRenaming = renamingId === node.id
  const isMenuOpen = menuOpenId === node.id
  // "Exportar" troca o conteúdo do menu pelas formas de exportar, como o
  // "Compartilhar" das requisições; fechar o menu volta à lista completa.
  const [showExportOptions, setShowExportOptions] = useState(false)
  if (!isMenuOpen && showExportOptions) setShowExportOptions(false)
  const label = node.name || t('common.unnamed')
  const toggleLabel = t(isExpanded ? 'collections.collapseAria' : 'collections.expandAria', { name: label })
  const toggleTooltip = useTooltip(toggleLabel)
  const kind: NodeKind = depth === 0 ? 'collection' : 'folder'
  const isSelected = selectedIds.has(node.id)
  const isDragging = draggedId === node.id || (groupDragging && isSelected)
  const ownDropIndicator = dragOverId === node.id ? dropIndicator : null
  const nextSortDirection = nextSortDirectionFor(node.id)

  const commit = () => onCommitRename(node.id, draftName)
  const startRename = () => {
    setDraftName(node.name)
    onStartRename(node.id)
    onCloseMenu()
  }
  const handleItemShortcut = useItemShortcuts({
    rename: startRename,
    remove: () => onRemoveShortcut(node.id, kind, label),
  })

  const classNames = ['collections-row']
  if (kind === 'collection') classNames.push('collections-row--collection')
  if (isFavorite) classNames.push('collections-row--favorite')
  if (ownDropIndicator) classNames.push(`collections-row--drop-${ownDropIndicator}`)
  if (isSelected) classNames.push('collections-row--selected')
  pushSelectionJoinClasses(classNames, selectionJoins.get(node.id))
  if (isDragging) classNames.push('collections-row--dragging')

  return (
    <li className="collections-node">
      <div
        ref={rowRef}
        className={classNames.join(' ')}
        style={{ paddingLeft: `${depth * 12}px` }}
        data-drop-id={node.id}
        data-drop-kind={kind}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          onDragPointerDown(node.id, kind, label, event)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onOpenMenu(node.id)
        }}
        tabIndex={-1}
        onClick={(event) => {
          if (onSelectClick(node.id, event)) return
          // Só expandir deixa o item "em uso"; recolher ou clicar num item vazio o larga — sem o
          // foco, a linha não fica destacada como se ainda estivesse selecionada.
          if (!hasChildren || isExpanded) event.currentTarget.blur()
          if (hasChildren) onToggleExpanded(node.id)
        }}
        onKeyDown={handleItemShortcut}
      >
        {selectionMode && <RowCheckbox checked={isSelected} label={label} />}
        {hasChildren ? (
          <>
            <button
              type="button"
              className="collections-toggle"
              onClick={(event) => {
                event.stopPropagation()
                onToggleExpanded(node.id)
              }}
              aria-label={toggleLabel}
              {...toggleTooltip.triggerProps}
            >
              <ChevronIcon expanded={isExpanded} />
            </button>
            {toggleTooltip.tooltip}
          </>
        ) : (
          <span className="collections-toggle-spacer" aria-hidden="true" />
        )}

        <FolderIcon className="collections-folder-icon" size={13} aria-hidden="true" />

        {isRenaming ? (
          <InlineEditInput
            className="collections-name-input"
            value={draftName}
            autoFocus
            aria-label={t('common.name')}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commit}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
          />
        ) : (
          <span className="collections-node-name" title={label} data-change-kind={changeKind ?? nestedChangeKind}>
            {label}
          </span>
        )}

        {kind === 'collection' && node.labels && node.labels.length > 0 && <CollectionLabelDots labels={node.labels} />}

        {changeKind ? <ChangeMarker kind={changeKind} /> : nestedChangeKind ? <ChangeDot kind={nestedChangeKind} /> : null}

        {kind === 'collection' && onToggleFavorite && (
          <IconButton
            className="collections-favorite-button"
            icon={<StarIcon size={12} filled={isFavorite} />}
            label={t(isFavorite ? 'collections.unfavoriteAction' : 'collections.favoriteAction', { name: label })}
            aria-pressed={isFavorite}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite(node.id)
            }}
          />
        )}

        <IconButton
          className="collections-sort-button"
          icon={nextSortDirection === 'ascending' ? <SortAscendingIcon size={12} /> : <SortDescendingIcon size={12} />}
          label={t(nextSortDirection === 'ascending' ? 'collections.sortAscendingAction' : 'collections.sortDescendingAction')}
          disabled={!hasChildren}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onSort(node.id)
          }}
        />

        <OptionsMenu
          label={t('collections.moreOptionsAria', { name: label })}
          wrapperClassName="collections-menu-wrapper"
          menuClassName="collections-menu"
          menuPlacement="auto"
          menuBoundarySelector=".env-sidebar"
          isOpen={isMenuOpen}
          onToggle={() => onToggleMenu(node.id)}
          onClose={onCloseMenu}
        >
          {showExportOptions ? (
            <>
              {kind === 'collection' && (
                <MenuItem
                  label={t('collections.exportMenu.alcy')}
                  autoFocus
                  onSelect={() => {
                    onExport(node.id)
                    onCloseMenu()
                  }}
                />
              )}
              <MenuItem
                label={t('collections.exportMenu.webclient')}
                autoFocus={kind !== 'collection'}
                disabled={!containsRequest(node)}
                onSelect={() => {
                  onExportWebclient(node.id)
                  onCloseMenu()
                }}
              />
            </>
          ) : (
            <>
          {/* Grupos por função, separados por divisórias: criar, executar, organizar (só collections),
              configurar, editar e, por último, remover. */}
          <MenuItem
            label={t('collections.addFolderMenuItem')}
            onSelect={() => {
              onAddFolder(node.id)
              onCloseMenu()
            }}
          />
          <MenuItem
            label={t('collections.addRequestMenuItem')}
            onSelect={() => {
              if (rowRef.current) onOpenAddRequest(node.id, rowRef.current.getBoundingClientRect())
              onCloseMenu()
            }}
          />
          <MenuSeparator />
          <MenuItem
            label={t('collections.runMenuItem')}
            onSelect={() => {
              onRun(node.id)
              onCloseMenu()
            }}
          />
          <MenuItem
            label={t('collections.generateFlowMenuItem')}
            disabled={!containsRequest(node)}
            onSelect={() => {
              onGenerateFlow(node.id)
              onCloseMenu()
            }}
          />
          {kind === 'collection' && (onToggleFavorite || onOpenLabels) && (
            <>
              <MenuSeparator />
              {onToggleFavorite && (
                <MenuItem
                  label={t(isFavorite ? 'collections.unfavoriteMenuItem' : 'collections.favoriteMenuItem')}
                  onSelect={() => {
                    onToggleFavorite(node.id)
                    onCloseMenu()
                  }}
                />
              )}
              {onOpenLabels && (
                <MenuItem
                  label={t('collections.labelsMenuItem')}
                  onSelect={() => {
                    onOpenLabels(node.id)
                    onCloseMenu()
                  }}
                />
              )}
            </>
          )}
          <MenuSeparator />
          <MenuItem
            label={t('collections.manageMenuItem')}
            onSelect={() => {
              onOpenSettings(node.id)
              onCloseMenu()
            }}
          />
          {FEATURE_FLAGS.webclientExport ? (
            <MenuItem
              label={t('collections.exportMenuItem')}
              disabled={kind === 'folder' && !containsRequest(node)}
              onSelect={() => setShowExportOptions(true)}
            />
          ) : (
            kind === 'collection' && (
              <MenuItem
                label={t('collections.exportMenuItem')}
                onSelect={() => {
                  onExport(node.id)
                  onCloseMenu()
                }}
              />
            )
          )}
          <MenuSeparator />
          <MenuItem label={t('collections.renameMenuItem')} onSelect={startRename} />
          <MenuItem
            label={t('collections.selectMenuItem')}
            onSelect={() => {
              onStartSelection(node.id)
              onCloseMenu()
            }}
          />
          <MenuSeparator />
          <MenuItem
            label={t('common.remove')}
            danger
            onSelect={() => {
              onRemove(node.id, kind, label)
              onCloseMenu()
            }}
          />
            </>
          )}
        </OptionsMenu>
      </div>

      {hasChildren && isExpanded && (
        <ul className="collections-children">
          {node.folders.map((child) => (
            <FolderRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              openRequestId={openRequestId}
              renamingId={renamingId}
              menuOpenId={menuOpenId}
              changeMarkers={changeMarkers}
              nestedChangeMarkers={nestedChangeMarkers}
              onToggleExpanded={onToggleExpanded}
              onAddFolder={onAddFolder}
              onOpenAddRequest={onOpenAddRequest}
              onOpenRequest={onOpenRequest}
              onPinRequest={onPinRequest}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onRemove={onRemove}
              onRemoveShortcut={onRemoveShortcut}
              onDuplicateRequest={onDuplicateRequest}
              onMoveRequest={onMoveRequest}
              onExport={onExport}
              onExportWebclient={onExportWebclient}
              onRun={onRun}
              onGenerateFlow={onGenerateFlow}
              onOpenSettings={onOpenSettings}
              nextSortDirectionFor={nextSortDirectionFor}
              onSort={onSort}
              onToggleMenu={onToggleMenu}
              onOpenMenu={onOpenMenu}
              onCloseMenu={onCloseMenu}
              draggedId={draggedId}
              dragOverId={dragOverId}
              dropIndicator={dropIndicator}
              onDragPointerDown={onDragPointerDown}
              selectedIds={selectedIds}
              selectionJoins={selectionJoins}
              selectionMode={selectionMode}
              groupDragging={groupDragging}
              onSelectClick={onSelectClick}
              onStartSelection={onStartSelection}
            />
          ))}
          {node.requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              depth={depth + 1}
              isOpen={openRequestId === request.id}
              isDragging={draggedId === request.id || (groupDragging && selectedIds.has(request.id))}
              isSelected={selectedIds.has(request.id)}
              selectionJoin={selectionJoins.get(request.id)}
              selectionMode={selectionMode}
              dropIndicator={dragOverId === request.id ? dropIndicator : null}
              renamingId={renamingId}
              menuOpenId={menuOpenId}
              changeKind={changeMarkers.get(request.id)}
              onOpen={onOpenRequest}
              onPin={onPinRequest}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onRemove={onRemove}
              onRemoveShortcut={onRemoveShortcut}
              onDuplicate={onDuplicateRequest}
              onMove={onMoveRequest}
              onGenerateFlow={onGenerateFlow}
              onToggleMenu={onToggleMenu}
              onOpenMenu={onOpenMenu}
              onCloseMenu={onCloseMenu}
              onDragPointerDown={onDragPointerDown}
              onSelectClick={onSelectClick}
              onStartSelection={onStartSelection}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function CollectionsPanel({
  collections,
  expandedIds,
  openRequestId,
  changeMarkers,
  onToggleExpanded,
  onCollapseAll,
  onExpandAll,
  onRevealRequest,
  onAddCollection,
  onAddFolder,
  onAddRequest,
  onCreateStandaloneRequest,
  onOpenRequest,
  onPinRequest,
  onRename,
  onUpdateAuthentication,
  onUpdateVariables,
  favoriteIds,
  onSetFavorites,
  onAssignLabel,
  onRenameLabel,
  onRecolorLabel,
  onRemoveLabel,
  onRemove,
  onRemoveMany,
  onMoveMany,
  onDuplicateRequest,
  onMoveRequest,
  onReorderRequest,
  onMoveFolder,
  onReorderFolder,
  onReorderCollections,
  onSortChildren,
  onExportCollection,
  onExportCollections,
  onRunCollection,
  onGenerateFlow,
  onExportWebclient,
  onDropOnFlow,
  onExportAll,
  onPrepareImportFromPath,
  onPrepareImportFromUrl,
  onPrepareImportFromText,
  onCommitPreparedImport,
  environmentVariables,
  command = null,
  onCommandHandled,
}: CollectionsPanelProps) {
  const { t } = useLanguage()
  const nestedChangeMarkers = useMemo(() => nestedChangeKinds(collections, changeMarkers), [collections, changeMarkers])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [addRequestTarget, setAddRequestTarget] = useState<{ parentId: string; anchor: DOMRect } | null>(null)
  const [moveRequestId, setMoveRequestId] = useState<string | null>(null)
  const [settingsNodeId, setSettingsNodeId] = useState<string | null>(null)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importJobs, setImportJobs] = useState<Array<PreparedImportSelection & { status: 'pending' | 'running' | 'success' | 'error' | 'cancelled'; message?: string }>>([])
  const [importProgressOpen, setImportProgressOpen] = useState(true)
  const importCancelledRef = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  /** Pastas que o usuário colapsou durante a busca; valem só para o texto em que foram colapsadas. */
  const [searchCollapsed, setSearchCollapsed] = useState<{ query: string; ids: ReadonlySet<string> }>(() => ({
    query: '',
    ids: new Set(),
  }))
  /** Direção aplicada por último em cada collection/pasta; o botão mostra a próxima direção. */
  const [lastSortDirections, setLastSortDirections] = useState<ReadonlyMap<string, AlphabeticalSortDirection>>(() => new Map())
  /** Objeto novo a cada clique (não só o id) para que localizar a mesma requisição de novo role de novo. */
  const [revealTarget, setRevealTarget] = useState<{ id: string } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{ id: string; kind: NodeKind; label: string } | null>(null)
  /** Filtros por favoritas e rótulos (ADR 0060), combinados com o texto da busca. */
  const [filters, setFilters] = useState<CollectionFilters>(NO_COLLECTION_FILTERS)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  /** Modal de rótulos: das collections `collectionIds` (uma, ou a seleção múltipla) ou, com a lista
   * vazia, só para gerenciar o catálogo. */
  const [labelsModal, setLabelsModal] = useState<{ collectionIds: string[] } | null>(null)
  const catalog = useMemo(() => labelCatalog(collections), [collections])
  const labelUsage = useMemo(() => {
    const usage = new Map<string, number>()
    for (const collection of collections) {
      for (const label of collection.labels ?? []) {
        const key = labelKey(label.name)
        usage.set(key, (usage.get(key) ?? 0) + 1)
      }
    }
    return usage
  }, [collections])
  /** Um rótulo excluído ou renomeado sai do filtro sozinho, sem deixar um chip órfão. */
  const activeFilters: CollectionFilters = useMemo(() => {
    const labelKeys = new Set([...filters.labelKeys].filter((key) => labelUsage.has(key)))
    return { favoritesOnly: filters.favoritesOnly, labelKeys }
  }, [filters, labelUsage])
  const filtering = hasCollectionFilters(activeFilters)

  /** Seleção múltipla (spec 0104): estado visual local. `selectedIds` pode guardar ids que já saíram
   * da árvore ou estão dentro de outro item selecionado — `selection` é a versão normalizada (só o
   * que existe, sem descendentes de selecionados, na ordem da árvore) sobre a qual as ações agem. */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [pendingBatchRemove, setPendingBatchRemove] = useState(false)
  const [batchMoveOpen, setBatchMoveOpen] = useState(false)
  const selection = useMemo(() => topLevelSelection(collections, selectedIds), [collections, selectedIds])
  const isCollectionId = (id: string) => collections.some((collection) => collection.id === id)
  const selectionHasCollection = selection.some(isCollectionId)
  const selectionOnlyCollections = selection.length > 0 && selection.every(isCollectionId)
  const selectionRemovalCounts = useMemo(
    () => selection.reduce(
      (total, id) => {
        const node = findNode(collections, id)
        if (node) {
          const counts = contentCounts(node)
          return { folders: total.folders + counts.folders, requests: total.requests + counts.requests }
        }
        return { ...total, requests: total.requests + (findRequest(collections, id) ? 1 : 0) }
      },
      { folders: 0, requests: 0 },
    ),
    [collections, selection],
  )
  const pendingRemoveCounts = pendingRemove && pendingRemove.kind !== 'request'
    ? (() => {
        const node = findNode(collections, pendingRemove.id)
        return node ? contentCounts(node) : { folders: 0, requests: 0 }
      })()
    : { folders: 0, requests: 0 }
  /** Destinos proibidos para o grupo: os próprios itens e tudo dentro das pastas selecionadas. */
  const groupBlockedIds = useMemo(() => {
    const blocked = folderSubtreeIds(collections, selection)
    for (const id of selection) blocked.add(id)
    return blocked
  }, [collections, selection])

  const clearSelection = () => {
    setSelectedIds(new Set())
    setSelectionAnchorId(null)
    setSelectionMode(false)
  }

  /** Arrastar uma linha selecionada, com mais de um item na seleção, leva o grupo inteiro. */
  const isGroupDrag = (id: string) => selection.length > 1 && selectedIds.has(id)

  /** O grupo entra em pastas/coleções (sobre uma requisição, na pasta dela); com coleção na
   * seleção só o canvas de um flow aceita o grupo — coleções não se aninham. */
  const groupDropParentId = (target: DragRef<DropTargetKind>): string | null => {
    if (target.kind === 'flow' || selectionHasCollection || groupBlockedIds.has(target.id)) return null
    if (target.kind !== 'request') return target.id
    const parentId = findParentId(collections, target.id)
    return typeof parentId === 'string' && !groupBlockedIds.has(parentId) ? parentId : null
  }

  const requestRemove = (id: string, kind: NodeKind, label: string) => {
    setPendingRemove({ id, kind, label })
  }

  const runPreparedImports = async (items: PreparedImportSelection[]) => {
    importCancelledRef.current = false
    setImportProgressOpen(true)
    setImportJobs(items.map((item) => ({ ...item, status: 'pending' })))
    for (const item of items) {
      if (importCancelledRef.current) {
        void discardPreparedImport(item.summary.id)
        setImportJobs((current) => current.map((job) => job.summary.id === item.summary.id ? { ...job, status: 'cancelled' } : job))
        continue
      }
      setImportJobs((current) => current.map((job) => job.summary.id === item.summary.id ? { ...job, status: 'running', message: undefined } : job))
      const result = await onCommitPreparedImport(item.summary.id, item.includeDocumentation)
      setImportJobs((current) => current.map((job) => job.summary.id === item.summary.id
        ? result.ok
          ? { ...job, status: 'success', message: undefined }
          : { ...job, status: 'error', message: result.message }
        : job))
    }
  }

  const discardFailedImports = () => {
    for (const job of importJobs) {
      if (job.status === 'error') void discardPreparedImport(job.summary.id)
    }
  }

  /** Nem toda combinação arrastada/alvo faz algo (ex.: pasta sobre requisição) — usado tanto para decidir a
   * ação no drop quanto para não destacar um alvo que não vai reagir ao soltar. */
  const isValidDrop = (draggedKind: DropTargetKind, targetKind: DropTargetKind): boolean => {
    if (targetKind === 'flow') return true
    if (draggedKind === 'request') return true
    if (draggedKind === 'collection') return targetKind === 'collection'
    return targetKind !== 'request'
  }

  /** Favoritas ficam num grupo à parte no topo: reordenar collections só vale dentro do mesmo grupo. */
  const sameFavoriteGroup = (id: string, targetId: string) => favoriteIds.has(id) === favoriteIds.has(targetId)

  const canDrop = (dragged: DragRef<DropTargetKind>, target: DragRef<DropTargetKind>): boolean => {
    if (target.kind === 'flow') return true
    if (isGroupDrag(dragged.id)) return groupDropParentId(target) !== null
    if (dragged.kind === 'collection' && target.kind === 'collection' && !sameFavoriteGroup(dragged.id, target.id)) return false
    return isValidDrop(dragged.kind, target.kind)
  }

  const handleDrop = (
    dragged: DragRef<DropTargetKind>,
    target: DragRef<DropTargetKind>,
    zone: DropEdge,
    point: { x: number; y: number },
  ) => {
    const groupDrag = isGroupDrag(dragged.id)
    if (target.kind === 'flow') {
      onDropOnFlow(groupDrag ? selection : [dragged.id], target.id, point)
      return
    }
    if (groupDrag) {
      const parentId = groupDropParentId(target)
      if (parentId !== null) onMoveMany(selection, parentId)
      return
    }
    if (dragged.kind === 'flow' || !isValidDrop(dragged.kind, target.kind)) return
    const { reorder, indicator } = resolveDrop(dragged.kind, target.kind, zone)
    const edge: SiblingEdge = indicator === 'into' ? 'before' : indicator

    if (dragged.kind === 'request') {
      if (reorder) onReorderRequest(dragged.id, target.id, edge)
      else onMoveRequest(dragged.id, target.id)
      return
    }
    if (dragged.kind === 'collection') {
      if (sameFavoriteGroup(dragged.id, target.id)) onReorderCollections(dragged.id, target.id, edge)
      return
    }
    if (reorder) onReorderFolder(dragged.id, target.id, edge)
    else onMoveFolder(dragged.id, target.id)
  }

  const {
    draggedId,
    draggedKind,
    draggedLabel,
    dragOverId: rawDragOverId,
    dragOverKind,
    dragOverEdge,
    position,
    startDrag,
  } = usePointerDrag<DropTargetKind>({
    dropTargetAttribute: 'data-drop-id',
    dropKindAttribute: 'data-drop-kind',
    insideZone: true,
    onDrop: handleDrop,
  })

  const groupDragging = draggedId !== null && isGroupDrag(draggedId)
  const dragOverId =
    draggedId &&
    draggedKind &&
    rawDragOverId &&
    dragOverKind &&
    canDrop({ id: draggedId, kind: draggedKind }, { id: rawDragOverId, kind: dragOverKind })
      ? rawDragOverId
      : null
  // O canvas do flow não é uma linha: não há borda nem destaque de linha a desenhar. O grupo sempre
  // entra numa pasta — a da requisição alvo, ou a pasta alvo —, então o destaque é o de "para dentro".
  const dropIndicator: DropIndicator | null =
    !dragOverId || !draggedKind || !dragOverKind || !dragOverEdge || draggedKind === 'flow' || dragOverKind === 'flow'
      ? null
      : groupDragging
        ? 'into'
        : resolveDrop(draggedKind, dragOverKind, dragOverEdge).indicator

  /** Ctrl/Shift+clique são seleção, não o início de um arraste; Shift também não seleciona texto. */
  const startRowDrag = (id: string, kind: NodeKind, label: string, event: ReactPointerEvent) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (event.shiftKey) event.preventDefault()
      return
    }
    const dragLabel = isGroupDrag(id) ? t('collections.selectionDragLabel', { count: selection.length }) : label
    startDrag(id, kind, dragLabel, event)
  }

  const commitRename = (id: string, name: string) => {
    onRename(id, name)
    setRenamingId(null)
  }

  const addFolder = (parentId: string) => {
    const id = onAddFolder(parentId)
    setRenamingId(id)
    return id
  }

  const duplicateRequest = (id: string) => {
    const { id: newId, name, content } = onDuplicateRequest(id)
    onOpenRequest(newId, content, name)
  }

  const toggleMenu = (id: string) => {
    setMenuOpenId((current) => (current === id ? null : id))
  }

  /** Botão direito sempre abre o menu (não alterna) — clicar de novo no mesmo item não deveria fechá-lo. */
  const openMenu = (id: string) => setMenuOpenId(id)

  const closeMenu = () => setMenuOpenId(null)

  const nextSortDirection = (id: string): AlphabeticalSortDirection =>
    lastSortDirections.get(id) === 'ascending' ? 'descending' : 'ascending'

  const sortChildren = (id: string) => {
    const direction = nextSortDirection(id)
    onSortChildren(id, direction)
    setLastSortDirections((current) => new Map(current).set(id, direction))
  }

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
  }

  /** Só há o que localizar se a requisição aberta estiver de fato na árvore (abas avulsas não estão). */
  const canReveal = openRequestId !== null && findAncestorIds(collections, openRequestId) !== null

  const revealOpenRequest = () => {
    if (!openRequestId) return
    closeSearch()
    const collectionId = findAncestorIds(collections, openRequestId)?.[0]
    if (collectionId && !filteredCollections.some((collection) => collection.id === collectionId)) {
      setFilters(NO_COLLECTION_FILTERS)
    }
    onRevealRequest(openRequestId)
    setRevealTarget({ id: openRequestId })
  }

  /** A linha só existe no DOM depois que as pastas expandem e a busca fecha; rola até ela nesse commit. */
  useEffect(() => {
    if (!revealTarget) return
    document.querySelector(`[data-drop-id="${CSS.escape(revealTarget.id)}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [revealTarget])

  const trimmedQuery = searchQuery.trim()
  const isSearching = trimmedQuery.length > 0
  const orderedCollections = useMemo(() => sortFavoritesFirst(collections, favoriteIds), [collections, favoriteIds])
  const filteredCollections = filterCollections(orderedCollections, activeFilters, favoriteIds)
  const displayedCollections = isSearching ? filterTree(filteredCollections, trimmedQuery) : filteredCollections
  /** Enquanto a busca está ativa, ignora o estado de expansão do usuário e abre tudo — a árvore
   * filtrada já só contém pastas/coleções que casam com a busca ou têm algo por dentro que casa, então
   * escondê-las atrás de um "colapsado" anterior não ajudaria. O usuário ainda pode colapsar pastas
   * nos resultados; esse colapso é local à busca e volta a abrir tudo quando o texto muda. */
  const searchCollapsedIds = searchCollapsed.query === trimmedQuery ? searchCollapsed.ids : new Set<string>()
  const renderExpandedIds = isSearching
    ? new Set([...allFolderIds(displayedCollections)].filter((id) => !searchCollapsedIds.has(id)))
    : expandedIds
  const toggleExpanded = (id: string) => {
    if (!isSearching) {
      onToggleExpanded(id)
      return
    }
    const ids = new Set(searchCollapsedIds)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    setSearchCollapsed({ query: trimmedQuery, ids })
  }

  const selectionJoins = new Map<string, SelectionJoin>()
  if (selectedIds.size > 0) {
    const visible = visibleItemIds(displayedCollections, renderExpandedIds)
    visible.forEach((id, index) => {
      if (!selectedIds.has(id)) return
      const above = index > 0 && selectedIds.has(visible[index - 1])
      const below = index < visible.length - 1 && selectedIds.has(visible[index + 1])
      if (above || below) selectionJoins.set(id, { above, below })
    })
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => toggleTreeSelection(collections, current, id))
  }

  /**
   * Shift+clique seleciona o intervalo de linhas visíveis entre a âncora (último item clicado) e
   * `id` — somando à seleção com Ctrl junto; Ctrl/Cmd+clique, ou qualquer clique no modo seleção,
   * alterna o item. Ctrl/Shift+clique liga o modo seleção (checkboxes), igual ao menu "Selecionar".
   * Fora dele, um clique simples limpa a seleção e segue o comportamento normal da linha.
   */
  const handleSelectClick = (id: string, event: ReactMouseEvent): boolean => {
    const additive = event.ctrlKey || event.metaKey
    if (event.shiftKey && selectionAnchorId !== null) {
      const visible = visibleItemIds(displayedCollections, renderExpandedIds)
      const from = visible.indexOf(selectionAnchorId)
      const to = visible.indexOf(id)
      if (from !== -1 && to !== -1) {
        const range = withDescendants(collections, visible.slice(Math.min(from, to), Math.max(from, to) + 1))
        setSelectedIds((current) => new Set(additive ? [...current, ...range] : range))
        setSelectionMode(true)
        return true
      }
    }
    setSelectionAnchorId(id)
    if (event.shiftKey || additive || selectionMode) {
      setSelectionMode(true)
      toggleSelected(id)
      return true
    }
    if (selectedIds.size > 0) setSelectedIds(new Set())
    return false
  }

  const startSelection = (id: string) => {
    setSelectionMode(true)
    setSelectionAnchorId(id)
    setSelectedIds((current) => new Set([...current, ...withDescendants(collections, [id])]))
  }

  const removeSelection = () => {
    if (selection.length !== 1) {
      setPendingBatchRemove(true)
      return
    }
    // Um item só segue a mesma confirmação da remoção individual.
    const [id] = selection
    const node = findNode(collections, id)
    const kind: NodeKind = isCollectionId(id) ? 'collection' : node ? 'folder' : 'request'
    requestRemove(id, kind, (node?.name ?? findRequest(collections, id)?.name) || t('common.unnamed'))
  }

  const removeFromShortcut = (id: string, kind: NodeKind, label: string) => {
    if (selection.length > 1 && selectedIds.has(id)) removeSelection()
    else requestRemove(id, kind, label)
  }

  /** Comando de um atalho global, aplicado no render em que chega (estado local); o efeito
   * abaixo foca a busca e avisa o workbench, que o descarta — remontar o painel não o repete. */
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [appliedCommand, setAppliedCommand] = useState<CollectionsCommand | null>(null)
  if (command && command !== appliedCommand) {
    setAppliedCommand(command)
    if (command.kind === 'import') setImportModalOpen(true)
    else if (command.kind === 'search') setSearchOpen(true)
    else {
      // A collection nova não casaria com a busca nem com os filtros abertos.
      setSearchOpen(false)
      setSearchQuery('')
      setFilters(NO_COLLECTION_FILTERS)
      setRenamingId(command.id)
    }
  }

  useEffect(() => {
    if (!command) return
    if (command.kind === 'search') searchInputRef.current?.focus()
    onCommandHandled?.()
  }, [command, onCommandHandled])

  /** Fecha o menu de opções aberto ao clicar fora dele — independente de hover/foco, para que o menu
   * (aberto por clique direito ou pelo botão "..." de uma linha, ou pelo "..." da barra de ferramentas)
   * permaneça ativo até um clique fora ou a abertura de outro menu (que já fecha este por reusar o
   * mesmo estado `menuOpenId`/`moreMenuOpen`). `pointerdown` dispara antes de `contextmenu`, então
   * clicar com o botão direito em outra linha fecha este menu antes de abrir o novo, sem piscar.
   * O seletor usa `.ui-menu-host` (classe comum de todo `OptionsMenu`, ver `Menu.tsx`) em vez de
   * `.collections-menu-wrapper` — que só cobre o menu de linha — para não fechar o próprio menu
   * "..." (`.collections-toolbar-menu-wrapper`) no `pointerdown` de um clique nos seus próprios
   * itens, o que impediria o `click` seguinte de chegar a eles. */
  useEffect(() => {
    if (menuOpenId === null && !moreMenuOpen && !filterMenuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest('.ui-menu-host')) return
      setMenuOpenId(null)
      setMoreMenuOpen(false)
      setFilterMenuOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpenId, moreMenuOpen, filterMenuOpen])

  const collectionIds = () => collections.map((collection) => collection.id)

  const toggleFavorite = (id: string) => onSetFavorites([id], !favoriteIds.has(id), collectionIds())

  /** Na seleção múltipla, a estrela desmarca só quando todas já são favoritas; senão, marca todas. */
  const selectionAllFavorite = selectionOnlyCollections && selection.every((id) => favoriteIds.has(id))
  const toggleSelectionFavorite = () => onSetFavorites(selection, !selectionAllFavorite, collectionIds())

  const toggleFavoritesFilter = () => setFilters((current) => ({ ...current, favoritesOnly: !current.favoritesOnly }))

  const toggleLabelFilter = (key: string) =>
    setFilters((current) => {
      const labelKeys = new Set(current.labelKeys)
      if (labelKeys.has(key)) labelKeys.delete(key)
      else labelKeys.add(key)
      return { ...current, labelKeys }
    })

  const clearFilters = () => {
    setFilters(NO_COLLECTION_FILTERS)
    setFilterMenuOpen(false)
  }

  /** Disponível com a busca aberta ou fechada: filtrar só por rótulos não exige digitar nada. */
  const filterMenu = collections.length > 0 && (
    <OptionsMenu
      label={t('collections.filterMenuAria')}
      icon={<FilterIcon size={12} />}
      wrapperClassName="collections-filter-menu-wrapper"
      buttonClassName="ui-icon-button collections-filter-button"
      buttonDataState={filtering ? 'active' : undefined}
      menuClassName="collections-menu collections-filter-menu"
      isOpen={filterMenuOpen}
      onToggle={() => setFilterMenuOpen((current) => !current)}
      onClose={() => setFilterMenuOpen(false)}
    >
      <MenuCheckboxItem
        label={t('collections.filterFavoritesOnly')}
        checked={activeFilters.favoritesOnly}
        leading={<StarIcon size={12} filled className="collections-filter-star" />}
        autoFocus
        onToggle={toggleFavoritesFilter}
      />
      <MenuSeparator />
      {catalog.length === 0 ? (
        <MenuItem label={t('collections.filterNoLabels')} disabled onSelect={() => undefined} />
      ) : (
        catalog.map((label) => (
          <MenuCheckboxItem
            key={labelKey(label.name)}
            label={label.name}
            checked={activeFilters.labelKeys.has(labelKey(label.name))}
            leading={<LabelDot color={label.color} />}
            onToggle={() => toggleLabelFilter(labelKey(label.name))}
          />
        ))
      )}
      <MenuSeparator />
      <MenuItem
        label={t('collections.manageLabelsMenuItem')}
        onSelect={() => {
          setLabelsModal({ collectionIds: [] })
          setFilterMenuOpen(false)
        }}
      />
      {filtering && <MenuItem label={t('collections.clearFilters')} onSelect={clearFilters} />}
    </OptionsMenu>
  )

  /** Collections-alvo que ainda existem; o modal fecha se todas saírem da árvore enquanto aberto. */
  const labelsModalTargets = (labelsModal?.collectionIds ?? []).flatMap((id) => {
    const collection = collections.find((candidate) => candidate.id === id)
    return collection ? [collection] : []
  })

  return (
    <div className="sidebar-panel-layout">
      {/* Pinned above the tree: search, filters, active filter chips and the selection bar. */}
      <div className="sidebar-panel-toolbar">
        <div className="collections-toolbar">
          {searchOpen ? (
            <>
            <div className="collections-search">
              <SearchIcon size={12} className="collections-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                className="collections-search-input"
                value={searchQuery}
                autoFocus
                placeholder={t('collections.searchPlaceholder')}
                aria-label={t('collections.searchPlaceholder')}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeSearch()
                }}
              />
              <IconButton
                className="collections-search-close"
                icon={<CloseIcon size={11} />}
                label={t('collections.searchCloseAria')}
                onClick={closeSearch}
              />
            </div>
            {filterMenu}
            </>
          ) : (
            <>
              <IconButton icon={<SearchIcon size={12} />} label={t('collections.searchAria')} onClick={() => setSearchOpen(true)} />
              {filterMenu}
              <IconButton
                icon={<PlusIcon size={12} />}
                label={t('collections.addRequestMenuItem')}
                onClick={(event) => onCreateStandaloneRequest(event.currentTarget.getBoundingClientRect())}
              />
              <IconButton
                icon={<ImportIcon size={12} />}
                label={t('collections.importButton')}
                onClick={() => setImportModalOpen(true)}
              />
              <IconButton
                icon={expandedIds.size === 0 ? <ExpandAllIcon size={12} /> : <CollapseAllIcon size={12} />}
                label={t(expandedIds.size === 0 ? 'collections.expandAllAria' : 'collections.collapseAllAria')}
                onClick={expandedIds.size === 0 ? onExpandAll : onCollapseAll}
              />
              <IconButton
                icon={<LocateIcon size={12} />}
                label={t('collections.revealActiveAria')}
                disabled={!canReveal}
                onClick={revealOpenRequest}
              />
              {/* "Criar Collection" fica no popover do "+"; sem Collections o "..." não teria item nenhum. */}
              {collections.length > 0 && (
                <OptionsMenu
                  label={t('collections.moreOptionsMenuAria')}
                  wrapperClassName="collections-toolbar-menu-wrapper"
                  menuClassName="collections-menu"
                  isOpen={moreMenuOpen}
                  onToggle={() => setMoreMenuOpen((current) => !current)}
                  onClose={() => setMoreMenuOpen(false)}
                >
                  <MenuItem
                    label={t('collections.exportAllButton')}
                    onSelect={() => {
                      void onExportAll()
                      setMoreMenuOpen(false)
                    }}
                  />
                </OptionsMenu>
              )}
            </>
          )}
        </div>

        {filtering && (
          <div className="collections-filter-chips" role="group" aria-label={t('collections.activeFiltersAria')}>
            {activeFilters.favoritesOnly && (
              <span className="collection-label-chip">
                <StarIcon size={11} filled className="collection-label-chip-icon" />
                <span className="collection-label-chip-name">{t('collections.filterFavoritesChip')}</span>
                <IconButton
                  icon={<CloseIcon size={9} />}
                  label={t('collections.removeFilterAria', { name: t('collections.filterFavoritesChip') })}
                  onClick={toggleFavoritesFilter}
                />
              </span>
            )}
            {catalog
              .filter((label) => activeFilters.labelKeys.has(labelKey(label.name)))
              .map((label) => (
                <span key={labelKey(label.name)} className="collection-label-chip" data-label-color={label.color}>
                  <LabelDot color={label.color} />
                  <span className="collection-label-chip-name" title={label.name}>{label.name}</span>
                  <IconButton
                    icon={<CloseIcon size={9} />}
                    label={t('collections.removeFilterAria', { name: label.name })}
                    onClick={() => toggleLabelFilter(labelKey(label.name))}
                  />
                </span>
              ))}
            <button type="button" className="collections-filter-clear" onClick={clearFilters}>
              {t('collections.clearFilters')}
            </button>
          </div>
        )}

        {(selection.length > 0 || selectionMode) && (
          <div className="collections-selection-bar" role="toolbar" aria-label={t('collections.selectionBarAria')}>
            <span className="collections-selection-count">
              {selection.length === 1
                ? t('collections.selectionCountOne')
                : t('collections.selectionCount', { count: selection.length })}
            </span>
            <IconButton
              icon={<FolderOpenIcon size={13} />}
              label={t('collections.moveRequestButton')}
              disabled={selection.length === 0 || selectionHasCollection}
              onClick={() => setBatchMoveOpen(true)}
            />
            <IconButton
              icon={<DownloadIcon size={13} />}
              label={t('collections.exportMenuItem')}
              disabled={!selectionOnlyCollections}
              onClick={() => onExportCollections(selection)}
            />
            <IconButton
              icon={<StarIcon size={13} filled={selectionAllFavorite} />}
              label={t(selectionAllFavorite ? 'collections.selectionUnfavorite' : 'collections.selectionFavorite')}
              aria-pressed={selectionAllFavorite}
              disabled={!selectionOnlyCollections}
              onClick={toggleSelectionFavorite}
            />
            <IconButton
              icon={<TagIcon size={13} />}
              label={t('collections.selectionLabels')}
              disabled={!selectionOnlyCollections}
              onClick={() => setLabelsModal({ collectionIds: selection })}
            />
            <IconButton
              icon={<TrashIcon size={13} />}
              label={t('common.remove')}
              variant="danger"
              disabled={selection.length === 0}
              onClick={removeSelection}
            />
            <span className="collections-selection-divider" aria-hidden="true" />
            <IconButton icon={<CloseIcon size={11} />} label={t('collections.selectionClearAria')} onClick={clearSelection} />
          </div>
        )}
      </div>

      <div className="sidebar-panel-scroll">
        {collections.length === 0 ? (
          <EmptyState icon={<FolderIcon size={22} />} title={t('collections.emptyState')} />
        ) : (isSearching || filtering) && displayedCollections.length === 0 ? (
          isSearching ? (
            <EmptyState icon={<SearchIcon size={22} />} title={t('collections.searchEmptyState')} />
          ) : (
            <EmptyState icon={<FilterIcon size={22} />} title={t('collections.filtersEmptyState')} />
          )
        ) : (
          <ul
            className="collections-tree"
            aria-label={t('collections.treeLabel')}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || (selectedIds.size === 0 && !selectionMode)) return
              if (event.target instanceof HTMLInputElement) return
              clearSelection()
            }}
          >
            {displayedCollections.map((collection) => (
              <FolderRow
                key={collection.id}
                node={collection}
                depth={0}
                expandedIds={renderExpandedIds}
                openRequestId={openRequestId}
                renamingId={renamingId}
                menuOpenId={menuOpenId}
                changeMarkers={changeMarkers}
                nestedChangeMarkers={nestedChangeMarkers}
                onToggleExpanded={toggleExpanded}
                onAddFolder={addFolder}
                onOpenAddRequest={(parentId, anchor) => setAddRequestTarget({ parentId, anchor })}
                onOpenRequest={onOpenRequest}
                onPinRequest={onPinRequest}
                onStartRename={setRenamingId}
                onCommitRename={commitRename}
                onRemove={requestRemove}
                onRemoveShortcut={removeFromShortcut}
                onDuplicateRequest={duplicateRequest}
                onMoveRequest={setMoveRequestId}
                onExport={onExportCollection}
                onExportWebclient={onExportWebclient}
                onRun={onRunCollection}
                onGenerateFlow={onGenerateFlow}
                onOpenSettings={setSettingsNodeId}
                nextSortDirectionFor={nextSortDirection}
                onSort={sortChildren}
                onToggleMenu={toggleMenu}
                onOpenMenu={openMenu}
                onCloseMenu={closeMenu}
                draggedId={draggedId}
                dragOverId={dragOverId}
                dropIndicator={dropIndicator}
                onDragPointerDown={startRowDrag}
                selectedIds={selectedIds}
                selectionJoins={selectionJoins}
                selectionMode={selectionMode}
                groupDragging={groupDragging}
                onSelectClick={handleSelectClick}
                onStartSelection={startSelection}
                isFavorite={favoriteIds.has(collection.id)}
                onToggleFavorite={toggleFavorite}
                onOpenLabels={(id) => setLabelsModal({ collectionIds: [id] })}
              />
            ))}
          </ul>
        )}
      </div>

      <DragPreview label={draggedLabel} position={position} />

      {importJobs.length > 0 && typeof document !== 'undefined' && document.getElementById('rw-import-statusbar-slot') && createPortal(
        <div className="collections-import-progress" data-open={importProgressOpen}>
          {importProgressOpen && (
            <div className="collections-import-progress-panel" role="status" aria-live="polite">
              <div className="collections-import-progress-header">
                <div>
                  <strong>{t('collections.importProgressTitle')}</strong>
                  <span>{t('collections.importProgressCount', {
                    current: importJobs.filter((job) => job.status !== 'pending' && job.status !== 'running').length,
                    total: importJobs.length,
                  })}</span>
                </div>
                <IconButton icon={<CloseIcon size={13} />} label={t('common.close')} onClick={() => setImportProgressOpen(false)} />
              </div>
              <div className="collections-import-progress-list">
                {importJobs.map((job) => (
                  <div className="collections-import-progress-row" key={job.summary.id} data-status={job.status}>
                    {job.status === 'running' || job.status === 'pending' ? <Spinner size={14} /> : job.status === 'success' ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                    <span title={job.source}>{job.source}</span>
                    <small>{job.summary.format}</small>
                  </div>
                ))}
              </div>
              <div className="collections-import-progress-actions">
                {importJobs.some((job) => job.status === 'running' || job.status === 'pending') ? (
                  <Button variant="ghost" onClick={() => { importCancelledRef.current = true }}>{t('common.cancel')}</Button>
                ) : (
                  <>
                    {importJobs.some((job) => job.status === 'error') && <Button variant="ghost" onClick={() => void runPreparedImports(importJobs.filter((job) => job.status === 'error'))}>{t('common.retry')}</Button>}
                    <Button variant="ghost" onClick={() => { discardFailedImports(); setImportJobs([]) }}>{t('common.close')}</Button>
                  </>
                )}
              </div>
            </div>
          )}
          <button type="button" className="rw-statusbar-console collections-import-statusbar" aria-expanded={importProgressOpen} onClick={() => setImportProgressOpen((open) => !open)}>
            {importJobs.some((job) => job.status === 'running' || job.status === 'pending') ? <Spinner size={13} /> : importJobs.some((job) => job.status === 'error') ? <AlertIcon size={13} /> : <CheckIcon size={13} />}
            <span>{t('collections.importStatusbar')}</span>
            <span className="collections-import-statusbar-count">{importJobs.filter((job) => job.status !== 'pending' && job.status !== 'running').length}/{importJobs.length}</span>
          </button>
        </div>,
        document.getElementById('rw-import-statusbar-slot')!,
      )}

      {addRequestTarget !== null && (
        <NewRequestPopover
          anchor={addRequestTarget.anchor}
          onClose={() => setAddRequestTarget(null)}
          onSelect={(protocol) => {
            const { id, name: finalName } = onAddRequest(addRequestTarget.parentId, t('collections.newRequestName'), protocol)
            setAddRequestTarget(null)
            onOpenRequest(id, emptyRequestContent(protocol), finalName)
          }}
        />
      )}

      {moveRequestId !== null && (
        <MoveRequestModal
          collections={collections}
          onCreateCollection={onAddCollection}
          onCreateFolder={onAddFolder}
          onClose={() => setMoveRequestId(null)}
          onMove={(targetParentId) => {
            onMoveRequest(moveRequestId, targetParentId)
            setMoveRequestId(null)
          }}
        />
      )}

      {settingsNodeId !== null &&
        (() => {
          const node = findNode(collections, settingsNodeId)
          if (!node) return null
          return (
            <NodeSettingsModal
              kind={collections.some((collection) => collection.id === node.id) ? 'collection' : 'folder'}
              nodeId={node.id}
              name={node.name}
              authentication={node.authentication}
              variables={node.variables}
              environmentVariables={variablesAboveNode(environmentVariables, collections, node.id)}
              onSave={({ name, authentication, variables }) => {
                if (name !== node.name) onRename(node.id, name)
                onUpdateAuthentication(node.id, authentication)
                onUpdateVariables(node.id, variables)
              }}
              onClose={() => setSettingsNodeId(null)}
            />
          )
        })()}

      {labelsModal !== null && (labelsModal.collectionIds.length === 0 || labelsModalTargets.length > 0) && (
        <CollectionLabelsModal
          catalog={catalog}
          usage={labelUsage}
          targets={
            labelsModalTargets.length > 0
              ? {
                  title:
                    labelsModalTargets.length === 1
                      ? t('collections.labels.modalTitle', { name: labelsModalTargets[0].name })
                      : t('collections.labels.modalTitleMany', { count: labelsModalTargets.length }),
                  labelSets: labelsModalTargets.map((collection) => collection.labels ?? []),
                }
              : undefined
          }
          onAssign={
            labelsModalTargets.length > 0
              ? (label, assigned) => onAssignLabel(labelsModalTargets.map((collection) => collection.id), label, assigned)
              : undefined
          }
          onRename={onRenameLabel}
          onRecolor={onRecolorLabel}
          onRemove={onRemoveLabel}
          onClose={() => setLabelsModal(null)}
        />
      )}

      {importModalOpen && (
        <Suspense fallback={null}>
          <ImportCollectionModal
            onClose={() => setImportModalOpen(false)}
            onPrepareFromPath={onPrepareImportFromPath}
            onPrepareFromUrl={onPrepareImportFromUrl}
            onPrepareFromText={onPrepareImportFromText}
            onImportPrepared={(items) => { discardFailedImports(); void runPreparedImports(items) }}
          />
        </Suspense>
      )}

      {batchMoveOpen && (
        <MoveRequestModal
          collections={collections}
          excludedIds={groupBlockedIds}
          title={t('collections.moveSelectionModalTitle', { count: selection.length })}
          onCreateCollection={onAddCollection}
          onCreateFolder={onAddFolder}
          onClose={() => setBatchMoveOpen(false)}
          onMove={(targetParentId) => {
            onMoveMany(selection, targetParentId)
            setBatchMoveOpen(false)
          }}
        />
      )}

      {pendingBatchRemove && (
        selectionHasCollection ? (
          <RemoveNodeModal
            kind="collection"
            name={t('collections.removeSelectionName', { count: selection.length })}
            folderCount={selectionRemovalCounts.folders}
            requestCount={selectionRemovalCounts.requests}
            title={t('collections.removeSelectionModalTitle', { count: selection.length })}
            description={t('collections.removeSelectionTypedDescription', {
              folders: selectionRemovalCounts.folders,
              requests: selectionRemovalCounts.requests,
            })}
            onRemove={() => {
              onRemoveMany(selection)
              setPendingBatchRemove(false)
              clearSelection()
            }}
            onCancel={() => setPendingBatchRemove(false)}
          />
        ) : (
          <ConfirmDialog
            title={t('collections.removeSelectionModalTitle', { count: selection.length })}
            description={t('collections.removeSelectionModalDescription', { count: selection.length })}
            confirmLabel={t('common.remove')}
            cancelLabel={t('common.cancel')}
            closeAriaLabel={t('collections.closeModalAria')}
            onConfirm={() => {
              onRemoveMany(selection)
              setPendingBatchRemove(false)
              clearSelection()
            }}
            onCancel={() => setPendingBatchRemove(false)}
          />
        )
      )}

      {pendingRemove && (
        <RemoveNodeModal
          kind={pendingRemove.kind}
          name={pendingRemove.label}
          folderCount={pendingRemoveCounts.folders}
          requestCount={pendingRemoveCounts.requests}
          onRemove={() => {
            onRemove(pendingRemove.id)
            setPendingRemove(null)
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  )
}
