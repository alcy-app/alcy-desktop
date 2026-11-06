import { useEffect, useRef, useState } from 'react'
import type { FlowFolderDto } from '../../bindings/list-flows'
import { DragPreview } from '../../shared/DragPreview'
import { usePointerDrag } from '../../shared/use-pointer-drag'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import type { ItemChangeKind } from '../../bindings/gitlab-types'
import { useLanguage } from '../../shared/i18n/use-language'
import { comboFromEvent, isShortcutFor } from '../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../shared/shortcuts/use-shortcuts'
import { ChangeMarker } from '../../shared/ui/ChangeMarker'
import { EmptyState } from '../../shared/ui/EmptyState'
import { IconButton } from '../../shared/ui/IconButton'
import { MenuItem, MenuSeparator, OptionsMenu } from '../../shared/ui/Menu'
import { MentionInChatMenuItem } from '../agent/MentionInChatMenuItem'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { Button } from '../../shared/ui/Button'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { Modal } from '../../shared/ui/Modal'
import { Select } from '../../shared/ui/Select'
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, FlowIcon, FolderIcon, ImportIcon, LoadTestIcon, PlusIcon, SearchIcon, Spinner } from '../../shared/ui/icons'
import { VirtualizedList, type VirtualizedListHandle } from '../request-workbench/components/VirtualizedList'
import type { FlowState } from './flows.types'
import type { FlowExportSource } from '../../bindings/export-flow'
import { ExportFlowModal } from './ExportFlowModal'
import { dtoFromFlow } from './use-flows-state'
import { RemoveFlowModal } from './RemoveFlowModal'
import { FlowTemplatesModal } from './FlowTemplatesModal'
import type { FlowTemplateId } from './flow-templates'
import './flows-panel.css'

interface FlowsPanelProps {
  exportContext?: Omit<FlowExportSource, 'flow'>
  flows: FlowState[]
  folders: FlowFolderDto[]
  saveError?: string | null
  changeMarkers: Map<string, ItemChangeKind>
  onAddFlow: (folderId?: string) => string
  onAddFlowFromTemplate: (templateId: FlowTemplateId, folderId?: string) => string
  onAddLoadFlow?: (folderId?: string) => string
  onImportLoadTest?: () => void
  onImportFlow?: () => void
  importingFlow?: boolean
  onRenameFlow: (id: string, name: string) => void
  onRemoveFlow: (id: string) => void
  onMoveFlow: (draggedId: string, targetId: string, edge: SiblingEdge) => void
  onOpenFlow: (id: string) => void
  onAddFolder: () => string
  onRenameFolder: (id: string, name: string) => void
  onRemoveFolder: (id: string) => void
  onMoveFolder: (id: string, targetId: string, edge: SiblingEdge) => void
  onMoveFlowToFolder: (flowId: string, folderId: string | null) => void
}

type Row = { kind: 'folder'; item: FlowFolderDto } | { kind: 'flow'; item: FlowState; folderId?: string }
const rowKey = (row: Row) => `${row.kind}:${row.item.id}`

function MoveFlowModal({ flow, folders, onMove, onCancel }: {
  flow: FlowState
  folders: FlowFolderDto[]
  onMove: (folderId: string | null) => void
  onCancel: () => void
}) {
  const { t } = useLanguage()
  const [folderId, setFolderId] = useState(folders.find((folder) => folder.flowIds.includes(flow.id))?.id ?? '')
  return (
    <Modal title={t('flows.moveToFolder')} closeAriaLabel={t('collections.closeModalAria')} onClose={onCancel} className="ui-modal--form">
      <Select autoFocus aria-label={t('flows.destinationFolder')} value={folderId} onChange={(event) => setFolderId(event.target.value)}>
        <option value="">{t('flows.rootFolder')}</option>
        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </Select>
      <div className="ui-modal-actions">
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={() => onMove(folderId || null)}>{t('flows.moveAction')}</Button>
      </div>
    </Modal>
  )
}

export function FlowsPanel({ exportContext, flows, folders, saveError, changeMarkers, onAddFlow, onAddFlowFromTemplate, onAddLoadFlow, onImportLoadTest, onImportFlow, importingFlow = false, onRenameFlow, onRemoveFlow, onMoveFlow, onOpenFlow, onAddFolder, onRenameFolder, onRemoveFolder, onMoveFolder, onMoveFlowToFolder }: FlowsPanelProps) {
  const { t } = useLanguage()
  const { bindings: shortcutBindings } = useShortcuts()
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [pendingRemove, setPendingRemove] = useState<Row | null>(null)
  const [movingFlow, setMovingFlow] = useState<FlowState | null>(null)
  const [exportSource, setExportSource] = useState<FlowExportSource | null>(null)
  const [menuOpenKey, setMenuOpenKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(() => new Set<string>())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [templateContext, setTemplateContext] = useState<{ folderId?: string } | null>(null)
  const templateTriggerRef = useRef<HTMLButtonElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<VirtualizedListHandle>(null)
  const rowButtonsRef = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    if (renamingKey) listRef.current?.scrollToKey(renamingKey)
  }, [renamingKey, flows, folders])

  const closeSearch = () => { setSearchOpen(false); setSearchQuery('') }
  const trimmedQuery = searchQuery.trim().toLowerCase()
  const isSearching = trimmedQuery.length > 0
  const matches = (name: string) => !isSearching || name.toLowerCase().includes(trimmedQuery)
  const folderByFlow = new Map(folders.flatMap((folder) => folder.flowIds.map((id) => [id, folder.id] as const)))
  const childrenByFolder = new Map<string, FlowState[]>()
  for (const flow of flows) {
    const folderId = folderByFlow.get(flow.id)
    if (!folderId) continue
    const children = childrenByFolder.get(folderId) ?? []
    children.push(flow)
    childrenByFolder.set(folderId, children)
  }
  const rows: Row[] = []
  for (const folder of folders) {
    const children = (childrenByFolder.get(folder.id) ?? []).filter((flow) => matches(folder.name) || matches(flow.name))
    if (isSearching && !matches(folder.name) && children.length === 0) continue
    rows.push({ kind: 'folder', item: folder })
    if (isSearching || expanded.has(folder.id)) {
      rows.push(...children.map((flow): Row => ({ kind: 'flow', item: flow, folderId: folder.id })))
    }
  }
  rows.push(...flows.filter((flow) => !folderByFlow.has(flow.id) && matches(flow.name)).map((flow): Row => ({ kind: 'flow', item: flow })))

  const expand = (id: string) => setExpanded((current) => new Set([...current, id]))
  const { draggedId, draggedKind, draggedLabel, dragOverId, dragOverEdge, position, startDrag } = usePointerDrag<'flow' | 'folder' | 'root'>({
    dropTargetAttribute: 'data-flow-drop-id',
    dropKindAttribute: 'data-flow-drop-kind',
    orientation: 'vertical',
    insideZone: true,
    onDrop: (dragged, target, edge) => {
      if (dragged.kind === 'folder') {
        if (target.kind === 'folder' && edge !== 'inside') onMoveFolder(dragged.id, target.id, edge)
      } else if (target.kind === 'root') {
        onMoveFlowToFolder(dragged.id, null)
      } else if (target.kind === 'folder') {
        onMoveFlowToFolder(dragged.id, target.id)
        expand(target.id)
      } else {
        onMoveFlow(dragged.id, target.id, edge === 'after' ? 'after' : 'before')
      }
    },
  })

  const rename = (row: Row) => { setRenamingKey(rowKey(row)); setNameDraft(row.item.name); setMenuOpenKey(null) }
  const addFlow = (folderId?: string, load = false) => {
    const id = load ? onAddLoadFlow?.(folderId) : onAddFlow(folderId)
    if (!id) return
    closeSearch()
    if (folderId) expand(folderId)
    setNameDraft(t(load ? 'flows.newLoadFlowName' : 'flows.newFlowName'))
    setRenamingKey(`flow:${id}`)
    setMenuOpenKey(null)
  }
  const addFolder = () => {
    setMenuOpenKey(null)
    closeSearch()
    setNameDraft(t('flows.newFolderName'))
    setRenamingKey(`folder:${onAddFolder()}`)
  }
  const openTemplates = (folderId?: string) => {
    templateTriggerRef.current = folderId
      ? rowButtonsRef.current.get(`folder:${folderId}`) ?? null
      : toolbarRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="true"]') ?? null
    setMenuOpenKey(null)
    setTemplateContext({ folderId })
  }
  const cancelTemplates = () => {
    setTemplateContext(null)
    templateTriggerRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="sidebar-panel-layout">
      <div ref={toolbarRef} className="flows-toolbar sidebar-panel-toolbar">
        {searchOpen ? (
          <div className="flows-search">
            <SearchIcon size={12} className="flows-search-icon" />
            <input type="text" className="flows-search-input" value={searchQuery} autoFocus placeholder={t('flows.searchPlaceholder')} aria-label={t('flows.searchPlaceholder')} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') closeSearch() }} />
            <IconButton className="flows-search-close" icon={<CloseIcon size={11} />} label={t('flows.searchCloseAria')} onClick={closeSearch} />
          </div>
        ) : (
          <>
            <IconButton icon={<SearchIcon size={12} />} label={t('flows.searchAria')} onClick={() => setSearchOpen(true)} />
            <OptionsMenu
              icon={<PlusIcon size={12} />}
              label={t('flows.addMenuAria')}
              isOpen={menuOpenKey === 'add'}
              onToggle={() => setMenuOpenKey((current) => current === 'add' ? null : 'add')}
              onClose={() => setMenuOpenKey(null)}
              menuPortal
              menuAlign="start"
              menuPlacement="auto"
            >
              <MenuItem icon={<FlowIcon size={13} />} label={t('flows.newBlankFlowMenuItem')} onSelect={() => addFlow()} />
              {onAddLoadFlow && <MenuItem icon={<LoadTestIcon size={13} />} label={t('flows.newBlankLoadTestMenuItem')} onSelect={() => addFlow(undefined, true)} />}
              <MenuSeparator />
              <MenuItem label={t('flows.templates.menu')} onSelect={() => openTemplates()} />
              <MenuItem label={t('flows.addFolderAria')} onSelect={addFolder} />
            </OptionsMenu>
            {onImportFlow
              ? <IconButton icon={importingFlow ? <Spinner size={12} /> : <ImportIcon size={12} />} label={t('flows.import.menu')} disabled={importingFlow} aria-busy={importingFlow || undefined} onClick={onImportFlow} />
              : onImportLoadTest && <IconButton icon={<ImportIcon size={12} />} label={t('flows.importLoadTestAria')} onClick={onImportLoadTest} />}
          </>
        )}
      </div>
      {saveError && <p className="flows-save-error" role="alert">{saveError}</p>}
      {folders.length > 0 && draggedKind === 'flow' && !isSearching && (
        <div className={`flows-root-drop ${dragOverId === 'root' ? 'flows-list-row--drop-inside' : ''}`} data-flow-drop-id="root" data-flow-drop-kind="root">{t('flows.rootFolder')}</div>
      )}
      {flows.length === 0 && folders.length === 0 ? (
        <div className="sidebar-panel-scroll"><EmptyState icon={<FlowIcon size={22} />} title={t('flows.emptyState')} /></div>
      ) : rows.length === 0 ? (
        <div className="sidebar-panel-scroll"><EmptyState icon={<SearchIcon size={22} />} title={t('flows.searchEmptyState')} /></div>
      ) : (
        <VirtualizedList ref={listRef} items={rows} getKey={rowKey} estimatedRowHeight={28} className="sidebar-panel-scroll flows-list" ariaLabel={t('flows.listLabel')} renderItem={(row) => {
          const { item, kind } = row
          const key = rowKey(row)
          const isRenaming = key === renamingKey
          const label = item.name || t('common.unnamed')
          const changeKind = kind === 'flow' ? changeMarkers.get(item.id) : undefined
          const open = isSearching || expanded.has(item.id)
          const RowIcon = row.kind === 'folder' ? FolderIcon : row.item.executionKind === 'load' ? LoadTestIcon : FlowIcon
          return (
            <div className={['flows-list-row', row.kind === 'flow' && row.folderId ? 'flows-list-row--nested' : '', draggedId === item.id ? 'flows-list-row--dragging' : '', dragOverId === item.id && dragOverEdge ? `flows-list-row--drop-${dragOverEdge}` : ''].filter(Boolean).join(' ')} data-flow-drop-id={item.id} data-flow-drop-kind={kind}
              onContextMenu={(event) => { event.preventDefault(); setMenuOpenKey(key) }}
              onPointerDown={(event) => {
                if (event.button !== 0 || isSearching || isRenaming || (event.target as HTMLElement).closest('.flows-menu-wrapper, .ui-menu')) return
                startDrag(item.id, kind, label, event)
              }}>
              {isRenaming ? (
                // Outside a <button>: the row button treats Space and clicks as activation,
                // which moved focus away from the input and ended the edit.
                <div className="flows-list-item flows-list-item--renaming">
                  {kind === 'folder' && (open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />)}
                  <RowIcon size={13} className="flows-list-item-icon" />
                  <InlineEditInput value={nameDraft} autoFocus aria-label={t(kind === 'folder' ? 'flows.folderNameAria' : 'flows.nameInputAria')}
                    onChange={(event) => { setNameDraft(event.target.value); if (event.target.value.trim()) (kind === 'folder' ? onRenameFolder : onRenameFlow)(item.id, event.target.value) }}
                    onBlur={() => setRenamingKey(null)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== 'Escape') return
                      event.preventDefault()
                      event.stopPropagation()
                      setRenamingKey(null)
                      requestAnimationFrame(() => rowButtonsRef.current.get(key)?.focus())
                    }} />
                </div>
              ) : (
                <button ref={(element) => { if (element) rowButtonsRef.current.set(key, element); else rowButtonsRef.current.delete(key) }} type="button" className="flows-list-item" aria-expanded={kind === 'folder' ? open : undefined}
                  onClick={(event) => {
                    event.currentTarget.focus()
                    if (kind === 'flow') onOpenFlow(item.id)
                    else if (!isSearching) setExpanded((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return
                    const combo = comboFromEvent(event)
                    if (isShortcutFor(shortcutBindings, 'renameItem', combo)) { event.preventDefault(); rename(row) }
                    else if (isShortcutFor(shortcutBindings, 'deleteItem', combo)) { event.preventDefault(); setPendingRemove(row) }
                    else if (kind === 'folder' && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
                      event.preventDefault()
                      if (event.key === 'ArrowRight') expand(item.id)
                      else setExpanded((current) => { const next = new Set(current); next.delete(item.id); return next })
                    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault()
                      const index = rows.findIndex((candidate) => rowKey(candidate) === key)
                      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
                      const nextKey = rowKey(rows[nextIndex])
                      listRef.current?.scrollToKey(nextKey)
                      requestAnimationFrame(() => rowButtonsRef.current.get(nextKey)?.focus())
                    }
                  }}>
                  {kind === 'folder' && (open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />)}
                  <RowIcon size={13} className="flows-list-item-icon" />
                  <span className="flows-list-item-name" data-change-kind={changeKind}>{label}</span>
                </button>
              )}
              {changeKind && <ChangeMarker kind={changeKind} />}
              <OptionsMenu label={t('flows.moreOptionsAria', { name: label })} wrapperClassName="flows-menu-wrapper" menuClassName="flows-menu" menuPlacement="auto" menuPortal isOpen={menuOpenKey === key} onToggle={() => setMenuOpenKey((current) => current === key ? null : key)} onClose={() => setMenuOpenKey(null)}>
                {kind === 'folder' && <MenuItem label={t('flows.addButtonAria')} onSelect={() => addFlow(item.id)} />}
                {kind === 'folder' && onAddLoadFlow && <MenuItem label={t('flows.addLoadFlowAria')} onSelect={() => addFlow(item.id, true)} />}
                {kind === 'folder' && <MenuItem label={t('flows.templates.menu')} onSelect={() => openTemplates(item.id)} />}
                <MenuItem label={t('flows.renameMenuItem')} shortcutAction="renameItem" onSelect={() => rename(row)} />
                {row.kind === 'flow' && <MenuItem label={t('flows.moveToFolder')} onSelect={() => { setMovingFlow(row.item); setMenuOpenKey(null) }} />}
                {row.kind === 'flow' && exportContext && <MenuItem label={t('flows.export.title')} onSelect={() => { setExportSource({ ...exportContext, flow: dtoFromFlow(row.item) }); setMenuOpenKey(null) }} />}
                {row.kind === 'flow' && <MentionInChatMenuItem item={{ kind: 'flow', id: item.id, label }} onDone={() => setMenuOpenKey(null)} />}
                <MenuItem label={t('common.remove')} shortcutAction="deleteItem" danger onSelect={() => { setPendingRemove(row); setMenuOpenKey(null) }} />
              </OptionsMenu>
            </div>
          )
        }} />
      )}
      <DragPreview label={draggedLabel} position={position} />
      {exportSource && <ExportFlowModal source={exportSource} onClose={() => setExportSource(null)} />}
      {templateContext && <FlowTemplatesModal loadTestingEnabled={!!onAddLoadFlow} onCancel={cancelTemplates} onCreate={(templateId) => {
        const id = onAddFlowFromTemplate(templateId, templateContext.folderId)
        closeSearch()
        if (templateContext.folderId) expand(templateContext.folderId)
        setTemplateContext(null)
        onOpenFlow(id)
      }} />}
      {pendingRemove?.kind === 'flow' && <RemoveFlowModal name={pendingRemove.item.name || t('common.unnamed')} onRemove={() => { onRemoveFlow(pendingRemove.item.id); setPendingRemove(null) }} onCancel={() => setPendingRemove(null)} />}
      {pendingRemove?.kind === 'folder' && <ConfirmDialog title={t('flows.removeFolderTitle')} description={t('flows.removeFolderDescription', { name: pendingRemove.item.name })} confirmLabel={t('common.remove')} cancelLabel={t('common.cancel')} closeAriaLabel={t('collections.closeModalAria')} onConfirm={() => { onRemoveFolder(pendingRemove.item.id); setPendingRemove(null) }} onCancel={() => setPendingRemove(null)} />}
      {movingFlow && <MoveFlowModal flow={movingFlow} folders={folders} onMove={(folderId) => { onMoveFlowToFolder(movingFlow.id, folderId); if (folderId) expand(folderId); setMovingFlow(null) }} onCancel={() => setMovingFlow(null)} />}
    </div>
  )
}
