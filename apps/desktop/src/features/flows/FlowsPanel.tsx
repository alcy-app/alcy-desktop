import { useState } from 'react'
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
import { MenuItem, OptionsMenu } from '../../shared/ui/Menu'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { CloseIcon, FlowIcon, ImportIcon, PlusIcon, RunnerIcon, SearchIcon } from '../../shared/ui/icons'
import type { FlowState } from './flows.types'
import { RemoveFlowModal } from './RemoveFlowModal'
import './flows-panel.css'

interface FlowsPanelProps {
  flows: FlowState[]
  /** Id do flow → tipo de alteração local ainda não enviada, para marcar a linha com "M"/"A"/"D". */
  changeMarkers: Map<string, ItemChangeKind>
  onAddFlow: () => string
  onAddLoadFlow?: () => string
  onImportLoadTest?: () => void
  onRenameFlow: (id: string, name: string) => void
  onRemoveFlow: (id: string) => void
  onMoveFlow: (draggedId: string, targetId: string, edge: SiblingEdge) => void
  onOpenFlow: (id: string) => void
}

export function FlowsPanel({ flows, changeMarkers, onAddFlow, onAddLoadFlow, onImportLoadTest, onRenameFlow, onRemoveFlow, onMoveFlow, onOpenFlow }: FlowsPanelProps) {
  const { t } = useLanguage()
  const { bindings: shortcutBindings } = useShortcuts()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
  }

  const trimmedQuery = searchQuery.trim().toLowerCase()
  const isSearching = trimmedQuery.length > 0
  // A ordem é a do arquivo (a que o arraste define): abrir ou editar um flow não a muda.
  const displayedFlows = flows.filter((flow) => !isSearching || flow.name.toLowerCase().includes(trimmedQuery))

  const { draggedId, draggedLabel, dragOverId, dragOverEdge, position, startDrag } = usePointerDrag<'flow'>({
    dropTargetAttribute: 'data-flow-drop-id',
    dropKindAttribute: 'data-flow-drop-kind',
    orientation: 'vertical',
    onDrop: (dragged, target, edge) => onMoveFlow(dragged.id, target.id, edge === 'after' ? 'after' : 'before'),
  })

  const pendingRemoveFlow = flows.find((flow) => flow.id === pendingRemoveId) ?? null

  const addFlow = () => {
    setRenamingId(onAddFlow())
  }
  const addLoadFlow = () => {
    if (onAddLoadFlow) setRenamingId(onAddLoadFlow())
  }

  return (
    <div className="sidebar-panel-layout">
      <div className="flows-toolbar sidebar-panel-toolbar">
        {searchOpen ? (
          <div className="flows-search">
            <SearchIcon size={12} className="flows-search-icon" />
            <input
              type="text"
              className="flows-search-input"
              value={searchQuery}
              autoFocus
              placeholder={t('flows.searchPlaceholder')}
              aria-label={t('flows.searchPlaceholder')}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeSearch()
              }}
            />
            <IconButton
              className="flows-search-close"
              icon={<CloseIcon size={11} />}
              label={t('flows.searchCloseAria')}
              onClick={closeSearch}
            />
          </div>
        ) : (
          <>
            <IconButton icon={<SearchIcon size={12} />} label={t('flows.searchAria')} onClick={() => setSearchOpen(true)} />
            {onImportLoadTest && <IconButton icon={<ImportIcon size={12} />} label={t('flows.importLoadTestAria')} onClick={onImportLoadTest} />}
            {onAddLoadFlow && <IconButton icon={<RunnerIcon size={12} />} label={t('flows.addLoadFlowAria')} onClick={addLoadFlow} />}
            <IconButton icon={<PlusIcon size={12} />} label={t('flows.addButtonAria')} onClick={addFlow} />
          </>
        )}
      </div>

      <div className="sidebar-panel-scroll">
        {flows.length === 0 ? (
          <EmptyState icon={<FlowIcon size={22} />} title={t('flows.emptyState')} />
        ) : isSearching && displayedFlows.length === 0 ? (
          <EmptyState icon={<SearchIcon size={22} />} title={t('flows.searchEmptyState')} />
        ) : (
          <ul className="flows-list" aria-label={t('flows.listLabel')}>
            {displayedFlows.map((flow) => {
              const isRenaming = flow.id === renamingId
              const label = flow.name || t('common.unnamed')
              const changeKind = changeMarkers.get(flow.id)
              return (
                <li
                  key={flow.id}
                  className={[
                    'flows-list-row',
                    draggedId === flow.id ? 'flows-list-row--dragging' : '',
                    dragOverId === flow.id && dragOverEdge ? `flows-list-row--drop-${dragOverEdge}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-flow-drop-id={flow.id}
                  data-flow-drop-kind="flow"
                  onContextMenu={(event) => {
                    // Botão direito sempre abre o menu (não alterna), como nas coleções.
                    event.preventDefault()
                    setMenuOpenId(flow.id)
                  }}
                  onPointerDown={(event) => {
                    // Com a busca ativa a lista é parcial, e renomeando o toque é do campo de nome.
                    if (event.button !== 0 || isSearching || isRenaming) return
                    startDrag(flow.id, 'flow', label, event)
                  }}
                >
                  <button
                    type="button"
                    className="flows-list-item"
                    onClick={(event) => {
                      // Foco explícito: o item focado é o alvo dos atalhos de
                      // renomear e remover, e nem toda WebView foca um botão ao clicar.
                      event.currentTarget.focus()
                      onOpenFlow(flow.id)
                    }}
                    onKeyDown={(event) => {
                      // Só com foco no próprio item, não no campo de nome dentro dele.
                      if (event.target !== event.currentTarget) return
                      const combo = comboFromEvent(event)
                      if (isShortcutFor(shortcutBindings, 'renameItem', combo)) {
                        event.preventDefault()
                        setRenamingId(flow.id)
                      } else if (isShortcutFor(shortcutBindings, 'deleteItem', combo)) {
                        event.preventDefault()
                        setPendingRemoveId(flow.id)
                      }
                    }}
                  >
                    <FlowIcon size={13} className="flows-list-item-icon" />
                    {isRenaming ? (
                      <InlineEditInput
                        value={flow.name}
                        autoFocus
                        aria-label={t('flows.nameInputAria')}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => onRenameFlow(flow.id, event.target.value)}
                        onBlur={() => setRenamingId(null)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') setRenamingId(null)
                        }}
                      />
                    ) : (
                      <span className="flows-list-item-name" data-change-kind={changeKind}>
                        {label}
                      </span>
                    )}
                  </button>
                  {changeKind && <ChangeMarker kind={changeKind} />}
                  <OptionsMenu
                    label={t('flows.moreOptionsAria', { name: label })}
                    wrapperClassName="flows-menu-wrapper"
                    menuClassName="flows-menu"
                    menuPlacement="auto"
                    menuBoundarySelector=".env-sidebar"
                    isOpen={menuOpenId === flow.id}
                    onToggle={() => setMenuOpenId((current) => (current === flow.id ? null : flow.id))}
                    onClose={() => setMenuOpenId(null)}
                  >
                    <MenuItem
                      label={t('flows.renameMenuItem')}
                      onSelect={() => {
                        setRenamingId(flow.id)
                        setMenuOpenId(null)
                      }}
                    />
                    <MenuItem
                      label={t('common.remove')}
                      danger
                      onSelect={() => {
                        setPendingRemoveId(flow.id)
                        setMenuOpenId(null)
                      }}
                    />
                  </OptionsMenu>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <DragPreview label={draggedLabel} position={position} />

      {pendingRemoveFlow && (
        <RemoveFlowModal
          name={pendingRemoveFlow.name || t('common.unnamed')}
          onRemove={() => {
            onRemoveFlow(pendingRemoveFlow.id)
            setPendingRemoveId(null)
          }}
          onCancel={() => setPendingRemoveId(null)}
        />
      )}
    </div>
  )
}
