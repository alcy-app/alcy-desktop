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
import { discardPreparedImport, type ImportVariableSelectionDto, type PrepareImportResult } from '../../../bindings/prepared-import'
import { importVariableSelections, type ExistingEnvironmentTarget } from '../import-variables'
import type { PreparedImportSelection } from './ImportCollectionModal'
import { CollectionLabelsModal, LabelDot } from './CollectionLabelsModal'
import { MoveRequestModal } from './MoveRequestModal'
import { NewRequestPopover } from './NewRequestPopover'
import { NodeSettingsModal } from './NodeSettingsModal'
import { RemoveNodeModal } from './RemoveNodeModal'
import { RequestMethodBadge } from './RequestMethodBadge'
import './collections-panel.css'
import './collection-labels.css'

// Load the import UI in its own chunk, outside app startup.
const ImportCollectionModal = lazy(() => import('./ImportCollectionModal').then((module) => ({ default: module.ImportCollectionModal })))

/** A collection is a root folder; dragging onto it reorders collections rather than nesting a folder. */
type NodeKind = 'request' | 'folder' | 'collection'

/** Drop targets are tree rows or the open flow canvas, marked with data-drop-kind="flow" (spec 0095). */
type DropTargetKind = NodeKind | 'flow'

/** Before/after highlight a sibling insertion edge; into highlights the whole row for nesting. */
type DropIndicator = 'before' | 'after' | 'into'

/** Resolve a drop from its target zone. Folder drops reorder at an edge or nest in the middle; other valid pairs have one outcome. */
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

/** A global shortcut requests renaming a new collection, importing, or focusing search. Each invocation has a new object. */
export type CollectionsCommand = { kind: 'rename'; id: string } | { kind: 'import' } | { kind: 'search' }

interface CollectionsPanelProps {
  collections: TreeNode[]
  expandedIds: Set<string>
  openRequestId: string | null
  /** Item ID to unpushed local change kind, displayed as M/A/D on tree rows. */
  changeMarkers: Map<string, ItemChangeKind>
  onToggleExpanded: (id: string) => void
  onCollapseAll: () => void
  onExpandAll: () => void
  onRevealRequest: (id: string) => void
  /** Create a collection with the supplied or default name and return its ID. */
  onAddCollection: (name?: string) => string
  /** Create a folder under parentId with the supplied or default name and return its ID. */
  onAddFolder: (parentId: string, name?: string) => string
  onAddRequest: (parentId: string, name: string, protocol: RequestProtocol) => { id: string; name: string }
  /** Open the type picker for a standalone draft from the toolbar. The anchor is the button rectangle; SaveRequestModal adds the request to a collection. */
  onCreateStandaloneRequest: (anchor: DOMRect) => void
  onOpenRequest: (id: string, content: RequestContent, name: string) => void
  /** Double-clicking pins a request tab, ending its italic preview state. */
  onPinRequest: (id: string) => void
  onRename: (id: string, name: string) => void
  onUpdateAuthentication: (id: string, authentication: AuthenticationInput) => void
  onUpdateVariables: (id: string, variables: ScopedVariableDto[]) => void
  /** Machine-local favorite collections appear first (ADR 0060). */
  favoriteIds: ReadonlySet<string>
  /** Toggle one or more favorites. existingIds lets the favorite state discard removed collections. */
  onSetFavorites: (ids: string[], favorite: boolean, existingIds: string[]) => void
  /** Toggle labels for one or more collections and manage the label catalog (ADR 0060). */
  onAssignLabel: (ids: string[], label: CollectionLabelDto, assigned: boolean) => void
  onRenameLabel: (oldName: string, newName: string) => void
  onRecolorLabel: (name: string, color: LabelColor) => void
  onRemoveLabel: (name: string) => void
  onRemove: (id: string) => void
  /** Remove the normalized selection together (spec 0104). */
  onRemoveMany: (ids: string[]) => void
  /** Move selected folders and requests to targetParentId together (spec 0104). */
  onMoveMany: (ids: string[], targetParentId: string) => void
  onDuplicateRequest: (id: string) => { id: string; name: string; content: RequestContent }
  onMoveRequest: (id: string, targetParentId: string) => void
  onReorderRequest: (id: string, targetId: string, edge: SiblingEdge) => void
  onMoveFolder: (id: string, targetParentId: string) => void
  onReorderFolder: (id: string, targetId: string, edge: SiblingEdge) => void
  onReorderCollections: (id: string, targetId: string, edge: SiblingEdge) => void
  onSortChildren: (id: string, direction: AlphabeticalSortDirection) => void
  onExportCollection: (id: string) => void
  /** Export selected collections into one file (spec 0104). */
  onExportCollections: (ids: string[]) => void
  /** Open the collection or folder runner (spec 0073). */
  onRunCollection: (id: string) => void
  /** Create a flow chaining the item's requests (spec 0095). */
  onGenerateFlow: (id: string) => void
  /** Open collection or folder export as a webclient (spec 0113). */
  onExportWebclient: (id: string) => void
  /** Drop an item or dragged selection onto a flow canvas; point uses screen coordinates (specs 0095 and 0104). */
  onDropOnFlow: (itemIds: string[], flowId: string, point: { x: number; y: number }) => void
  onExportAll: () => void
  onPrepareImportFromPath: (path: string) => Promise<PrepareImportResult>
  onPrepareImportFromUrl: (url: string) => Promise<PrepareImportResult>
  onPrepareImportFromText: (content: string) => Promise<PrepareImportResult>
  onCommitPreparedImport: (id: string, includeDocumentation: boolean, variables?: ImportVariableSelectionDto[]) => Promise<ImportOutcome>
  /** Workspace environments the import review can merge variables into (spec 0130). */
  importEnvironmentTargets: ExistingEnvironmentTarget[]
  /** Active environment variables used by the folder or collection authentication modal. */
  environmentVariables: EnvironmentVariableDto[]
  /** Execute a pending shortcut command and acknowledge it through onCommandHandled. */
  command?: CollectionsCommand | null
  onCommandHandled?: () => void
}

interface ItemShortcutHandlers {
  rename: () => void
  remove: () => void
  /** Only requests support duplication. */
  duplicate?: () => void
}

/** Handle F2, Ctrl+D, and Delete on a clicked row (tabIndex=-1) or its buttons, excluding an active rename field. */
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

/** Whether a folder contains any request at any depth and can generate a flow. */
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
  /** Removing a selected row through a shortcut removes the whole selection. */
  onRemoveShortcut: (id: string, kind: NodeKind, label: string) => void
  onDuplicate: (id: string) => void
  onMove: (id: string) => void
  onGenerateFlow: (id: string) => void
  onToggleMenu: (id: string) => void
  onOpenMenu: (id: string) => void
  onCloseMenu: () => void
  onDragPointerDown: (id: string, kind: NodeKind, label: string, event: ReactPointerEvent) => void
  /** Return true when modifiers or selection mode consume the click without opening or expanding. */
  onSelectClick: (id: string, event: ReactMouseEvent) => boolean
  /** The Select context-menu action enables selection mode with this item checked. */
  onStartSelection: (id: string) => void
}

/** Adjacent selected rows form one block without rounded corners between them. */
interface SelectionJoin {
  above: boolean
  below: boolean
}

function pushSelectionJoinClasses(classNames: string[], join: SelectionJoin | undefined) {
  if (join?.above) classNames.push('collections-row--joined-above')
  if (join?.below) classNames.push('collections-row--joined-below')
}

/** Reflect selection state; clicks bubble to the row that toggles it. */
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

        <div className="collections-row-actions">
          <OptionsMenu
            label={t('collections.moreOptionsAria', { name: label })}
            wrapperClassName="collections-menu-wrapper"
            menuClassName="collections-menu"
            menuPlacement="auto"
            menuPortal
            isOpen={isMenuOpen}
            onToggle={() => onToggleMenu(request.id)}
            onClose={onCloseMenu}
          >
            {/* Group menu actions with separators: generate, edit, organize, then remove. */}
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
  /** Folders or collections containing nested changes without a change of their own use a dot marker. */
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
  /** Dragging the selection dims every selected row. */
  groupDragging: boolean
  onSelectClick: (id: string, event: ReactMouseEvent) => boolean
  /** The Select context-menu action enables selection mode with this item checked. */
  onStartSelection: (id: string) => void
  /** Only root collections have favorites and labels. */
  isFavorite?: boolean
  onToggleFavorite?: (id: string) => void
  onOpenLabels?: (id: string) => void
}

/** Label dots follow the collection name; the tooltip lists their names. */
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
  // Export replaces menu contents with export formats, like request sharing.
  // Closing the menu restores the complete action list.
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
          // Expanding keeps the row focused; collapsing or clicking an empty row releases it
          // so the row does not retain a selection-like highlight.
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

        <div className="collections-row-actions">
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
            menuPortal
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
            {/* Group menu actions with separators: create, run, organize collections, settings, edit, then remove. */}
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
  importEnvironmentTargets,
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
  const [importProgressOpen, setImportProgressOpen] = useState(false)
  const importCancelledRef = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  /** Folders collapsed during search stay collapsed only for the current search text. */
  const [searchCollapsed, setSearchCollapsed] = useState<{ query: string; ids: ReadonlySet<string> }>(() => ({
    query: '',
    ids: new Set(),
  }))
  /** Last sort direction for each collection or folder; its button shows the next direction. */
  const [lastSortDirections, setLastSortDirections] = useState<ReadonlyMap<string, AlphabeticalSortDirection>>(() => new Map())
  /** A new object per click makes repeated reveal requests scroll to the item again. */
  const [revealTarget, setRevealTarget] = useState<{ id: string } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{ id: string; kind: NodeKind; label: string } | null>(null)
  /** Combine favorite and label filters with search text (ADR 0060). */
  const [filters, setFilters] = useState<CollectionFilters>(NO_COLLECTION_FILTERS)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  /** Edit labels for collectionIds, or manage the catalog when the list is empty. */
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
  /** Remove deleted or renamed labels from filters to avoid orphaned chips. */
  const activeFilters: CollectionFilters = useMemo(() => {
    const labelKeys = new Set([...filters.labelKeys].filter((key) => labelUsage.has(key)))
    return { favoritesOnly: filters.favoritesOnly, labelKeys }
  }, [filters, labelUsage])
  const filtering = hasCollectionFilters(activeFilters)

  /** Local selection state (spec 0104). Normalize stale IDs and selected descendants into existing top-level items in tree order before applying actions. */
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
  /** Exclude selected items and descendants of selected folders as group destinations. */
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

  /** Dragging a selected row carries the entire multi-item selection. */
  const isGroupDrag = (id: string) => selection.length > 1 && selectedIds.has(id)

  /** Groups enter the target folder or request parent. Groups containing collections can only enter a flow canvas, since collections cannot nest. */
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
    // The status bar shows progress; the detail panel opens only on click.
    setImportJobs(items.map((item) => ({ ...item, status: 'pending' })))
    for (const item of items) {
      if (importCancelledRef.current) {
        void discardPreparedImport(item.summary.id)
        setImportJobs((current) => current.map((job) => job.summary.id === item.summary.id ? { ...job, status: 'cancelled' } : job))
        continue
      }
      setImportJobs((current) => current.map((job) => job.summary.id === item.summary.id ? { ...job, status: 'running', message: undefined } : job))
      const result = await onCommitPreparedImport(item.summary.id, item.includeDocumentation, importVariableSelections(item.variables))
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

  /** Reject invalid dragged/target pairs both for the drop action and its highlight. */
  const isValidDrop = (draggedKind: DropTargetKind, targetKind: DropTargetKind): boolean => {
    if (targetKind === 'flow') return true
    if (draggedKind === 'request') return true
    if (draggedKind === 'collection') return targetKind === 'collection'
    return targetKind !== 'request'
  }

  /** Favorites form a separate group at the top; reorder collections only within their group. */
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
  // A flow canvas has no tree row edge to highlight. Groups always enter a folder:
  // either the target folder or the parent of the target request.
  const dropIndicator: DropIndicator | null =
    !dragOverId || !draggedKind || !dragOverKind || !dragOverEdge || draggedKind === 'flow' || dragOverKind === 'flow'
      ? null
      : groupDragging
        ? 'into'
        : resolveDrop(draggedKind, dragOverKind, dragOverEdge).indicator

  /** Ctrl/Shift clicks select rather than drag; Shift also prevents text selection. */
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

  /** Right-click always opens the menu rather than toggling it closed for the same row. */
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

  /** Reveal only requests that actually belong to the tree, excluding standalone tabs. */
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

  /** Scroll after expanding ancestors and closing search, when the row exists in the DOM. */
  useEffect(() => {
    if (!revealTarget) return
    document.querySelector(`[data-drop-id="${CSS.escape(revealTarget.id)}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [revealTarget])

  const trimmedQuery = searchQuery.trim()
  const isSearching = trimmedQuery.length > 0
  const orderedCollections = useMemo(() => sortFavoritesFirst(collections, favoriteIds), [collections, favoriteIds])
  const filteredCollections = filterCollections(orderedCollections, activeFilters, favoriteIds)
  const displayedCollections = isSearching ? filterTree(filteredCollections, trimmedQuery) : filteredCollections
  /** Search expands matching ancestors independently of saved expansion. Users can collapse results until the search text changes. */
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

  /** Shift selects the visible range from the anchor; Ctrl adds the range. Ctrl/Cmd or selection-mode clicks toggle items. Modifier clicks enable selection mode; plain clicks clear selection before opening. */
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
    // A single item uses the same confirmation as individual removal.
    const [id] = selection
    const node = findNode(collections, id)
    const kind: NodeKind = isCollectionId(id) ? 'collection' : node ? 'folder' : 'request'
    requestRemove(id, kind, (node?.name ?? findRequest(collections, id)?.name) || t('common.unnamed'))
  }

  const removeFromShortcut = (id: string, kind: NodeKind, label: string) => {
    if (selection.length > 1 && selectedIds.has(id)) removeSelection()
    else requestRemove(id, kind, label)
  }

  /** Apply a shortcut command in render; the effect focuses search and acknowledges it so remounting does not repeat the command. */
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [appliedCommand, setAppliedCommand] = useState<CollectionsCommand | null>(null)
  if (command && command !== appliedCommand) {
    setAppliedCommand(command)
    if (command.kind === 'import') setImportModalOpen(true)
    else if (command.kind === 'search') setSearchOpen(true)
    else {
      // A new collection may not match the current search or filters.
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

  /** Keep clicks inside inline and portaled menus available to their action handlers. */
  useEffect(() => {
    if (menuOpenId === null && !moreMenuOpen && !filterMenuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest('.ui-menu-host, .collections-menu')) return
      setMenuOpenId(null)
      setMoreMenuOpen(false)
      setFilterMenuOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpenId, moreMenuOpen, filterMenuOpen])

  const collectionIds = () => collections.map((collection) => collection.id)

  const toggleFavorite = (id: string) => onSetFavorites([id], !favoriteIds.has(id), collectionIds())

  /** Unfavorite a selection only when all its collections are already favorites; otherwise favorite all. */
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

  /** Label filtering works with search open or closed and does not require search text. */
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

  /** Keep only existing target collections; close the label modal when all targets disappear. */
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
              {/* Create Collection lives in the plus popover; an empty tree has no toolbar menu actions. */}
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
            existingEnvironments={importEnvironmentTargets}
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
