import { memo, useEffect, useState } from 'react'
import type { FocusEvent, MouseEvent as ReactMouseEvent } from 'react'
import { DragPreview } from '../../../shared/DragPreview'
import { useLanguage } from '../../../shared/i18n/use-language'
import { findShortcutAction, isShortcutEventConsumed } from '../../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../../shared/shortcuts/use-shortcuts'
import { hasOpenModal } from '../../../shared/ui/open-modals'
import { usePointerDrag } from '../../../shared/use-pointer-drag'
import type { DropEdge } from '../../../shared/use-pointer-drag'
import { CloseIcon, PinIcon, PlusIcon } from '../../../shared/ui/icons'
import { IconButton } from '../../../shared/ui/IconButton'
import { MenuItem } from '../../../shared/ui/Menu'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import '../../../shared/ui/menu.css'
import type { OpenTabDescriptor } from '../use-open-tabs'
import type { WorkbenchEnvironment } from '../request-workbench.types'
import { DiscardTabModal } from './DiscardTabModal'
import { EnvironmentSelect } from './EnvironmentSelect'
import { RequestMethodBadge } from './RequestMethodBadge'
import './open-tabs-bar.css'

interface OpenTabsBarProps {
  tabs: OpenTabDescriptor[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onPin: (id: string) => void
  onClose: (id: string) => void
  onCloseAll: () => void
  onCloseOthers: (id: string) => void
  onCloseUnfixed: () => void
  onCloseMany: (ids: string[]) => void
  onToggleFix: (id: string) => void
  /** Abre o popover de tipos de requisição, ancorado no retângulo do "+". */
  onNewTab: (anchor: DOMRect) => void
  onReorder: (draggedId: string, targetId: string, edge: DropEdge) => void
  onReorderGroup: (ids: string[], targetId: string, edge: DropEdge) => void
  onSaveTab: (id: string) => void
  environments: WorkbenchEnvironment[]
  activeEnvironmentId: string | null
  onEnvironmentChange: (id: string | null) => void
}

interface TabContextMenuState {
  tabId: string
  kind: OpenTabDescriptor['kind']
  label: string
  dirty: boolean
  fixed: boolean
  fixable: boolean
  /** Abas selecionadas em grupo quando o menu abriu sobre uma delas; 0 fora de uma seleção múltipla. */
  selectionCount: number
  x: number
  y: number
}

/** Ação de fechar abas pendente de confirmação — alguma das abas afetadas tem alterações não salvas. */
type PendingClose = { kind: 'tab'; tabId: string; label: string } | { kind: 'others'; tabId: string } | { kind: 'unfixed' } | { kind: 'selected'; ids: string[] } | { kind: 'all' }

function TabContextMenu({
  menu,
  onClose,
  onSaveTab,
  onCloseTab,
  onCloseAllTabs,
  onCloseOtherTabs,
  onCloseUnfixedTabs,
  onCloseSelectedTabs,
  onToggleFix,
}: {
  menu: TabContextMenuState
  onClose: () => void
  onSaveTab: () => void
  onCloseTab: () => void
  onCloseAllTabs: () => void
  onCloseOtherTabs: () => void
  onCloseUnfixedTabs: () => void
  onCloseSelectedTabs: () => void
  onToggleFix: () => void
}) {
  const { t } = useLanguage()

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      onClose()
    }
  }

  return (
    <div
      className="ui-menu rw-tab-context-menu"
      role="menu"
      aria-label={t('workbench.openTabs.contextMenuAria', { name: menu.label })}
      style={{ left: menu.x, top: menu.y }}
      onBlur={closeOnBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      {menu.selectionCount > 1 && (
        <MenuItem
          label={t('workbench.openTabs.closeSelectedTabsMenuItem', { count: menu.selectionCount })}
          autoFocus
          onSelect={() => {
            onCloseSelectedTabs()
            onClose()
          }}
        />
      )}
      {menu.selectionCount <= 1 && (
        <>
        <MenuItem
          label={t('workbench.openTabs.saveTabMenuItem')}
          disabled={menu.kind !== 'request' || !menu.dirty}
          autoFocus={menu.dirty}
          onSelect={() => {
            onSaveTab()
            onClose()
          }}
        />
        <MenuItem
          label={t(menu.fixed ? 'workbench.openTabs.unfixTabMenuItem' : 'workbench.openTabs.fixTabMenuItem')}
          disabled={!menu.fixable}
          onSelect={() => {
            onToggleFix()
            onClose()
          }}
        />
        <MenuItem
          label={t('workbench.openTabs.closeTabMenuItem')}
          autoFocus={!menu.dirty}
          onSelect={() => {
            onCloseTab()
            onClose()
          }}
        />
        <MenuItem
          label={t('workbench.openTabs.closeOtherTabsMenuItem')}
          onSelect={() => {
            onCloseOtherTabs()
            onClose()
          }}
        />
        </>
      )}
      <MenuItem
        label={t('workbench.openTabs.closeUnfixedTabsMenuItem')}
        onSelect={() => {
          onCloseUnfixedTabs()
          onClose()
        }}
      />
      <MenuItem
        label={t('workbench.openTabs.closeAllTabsMenuItem')}
        onSelect={() => {
          onCloseAllTabs()
          onClose()
        }}
      />
    </div>
  )
}

export const OpenTabsBar = memo(function OpenTabsBar({
  tabs,
  activeTabId,
  onSelect,
  onPin,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseUnfixed,
  onCloseMany,
  onToggleFix,
  onNewTab,
  onReorder,
  onReorderGroup,
  onSaveTab,
  environments,
  activeEnvironmentId,
  onEnvironmentChange,
}: OpenTabsBarProps) {
  const { t } = useLanguage()
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  /** Seleção múltipla: Ctrl/Cmd+clique alterna uma aba e Shift+clique marca o intervalo a partir da
   * âncora (a aba ativa, até o primeiro clique). Pode guardar ids de abas que já fecharam —
   * `selection` é a versão filtrada pelas abas que existem, na ordem da barra. */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const selection = tabs.filter((tab) => selectedIds.has(tab.id))
  const isGroupDrag = (id: string) => selection.length > 1 && selectedIds.has(id)

  const clearSelection = () => {
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  /** Devolve `true` quando o clique foi de seleção e não deve ativar a aba. */
  const handleSelectClick = (id: string, event: ReactMouseEvent): boolean => {
    const additive = event.ctrlKey || event.metaKey
    const anchor = anchorId !== null && tabs.some((tab) => tab.id === anchorId) ? anchorId : activeTabId
    if (event.shiftKey && anchor !== null) {
      const from = tabs.findIndex((tab) => tab.id === anchor)
      const to = tabs.findIndex((tab) => tab.id === id)
      if (from !== -1 && to !== -1) {
        const range = tabs.slice(Math.min(from, to), Math.max(from, to) + 1).map((tab) => tab.id)
        setSelectedIds((current) => new Set(additive ? [...current, ...range] : range))
        setAnchorId(anchor)
        return true
      }
    }
    if (additive || event.shiftKey) {
      setSelectedIds((current) => {
        const next = new Set(current.size === 0 && activeTabId !== null ? [activeTabId] : current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setAnchorId(id)
      return true
    }
    if (selectedIds.size > 0) clearSelection()
    return false
  }

  const { draggedId, draggedLabel, dragOverId, dragOverEdge, position, startDrag } = usePointerDrag<'tab'>({
    dropTargetAttribute: 'data-tab-drop-id',
    dropKindAttribute: 'data-tab-drop-kind',
    orientation: 'horizontal',
    onDrop: (dragged, target, edge) => {
      if (isGroupDrag(dragged.id)) {
        onReorderGroup(
          selection.map((tab) => tab.id),
          target.id,
          edge,
        )
        return
      }
      // As fixadas ficam sempre antes das demais: arrastar entre os dois grupos não faz nada.
      const draggedTab = tabs.find((tab) => tab.id === dragged.id)
      const targetTab = tabs.find((tab) => tab.id === target.id)
      if (draggedTab && targetTab && draggedTab.fixed !== targetTab.fixed) return
      onReorder(dragged.id, target.id, edge)
    },
  })

  const openContextMenu = (tab: OpenTabDescriptor, event: ReactMouseEvent) => {
    event.preventDefault()
    // Botão direito fora da seleção a desfaz; sobre uma aba selecionada, o menu age no grupo.
    const inGroup = selection.length > 1 && selectedIds.has(tab.id)
    if (!inGroup && selectedIds.size > 0) clearSelection()
    setContextMenu({
      tabId: tab.id,
      kind: tab.kind,
      label: tab.label,
      dirty: tab.dirty,
      fixed: tab.fixed,
      fixable: tab.fixable !== false,
      selectionCount: inGroup ? selection.length : 0,
      x: event.clientX,
      y: event.clientY,
    })
  }

  /** Fecha direto se não houver alterações não salvas entre as abas afetadas; caso contrário, pede confirmação. */
  const requestCloseTab = (tabId: string, label: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab && tab.dirty) {
      setPendingClose({ kind: 'tab', tabId, label })
    } else {
      onClose(tabId)
    }
  }

  const requestCloseOthers = (tabId: string) => {
    if (tabs.some((tab) => tab.id !== tabId && tab.dirty)) {
      setPendingClose({ kind: 'others', tabId })
    } else {
      onCloseOthers(tabId)
    }
  }

  const requestCloseMany = (ids: string[]) => {
    if (tabs.some((tab) => ids.includes(tab.id) && tab.dirty)) {
      setPendingClose({ kind: 'selected', ids })
    } else {
      onCloseMany(ids)
      clearSelection()
    }
  }

  const requestCloseUnfixed = () => {
    if (tabs.some((tab) => !tab.fixed && tab.dirty)) {
      setPendingClose({ kind: 'unfixed' })
    } else {
      onCloseUnfixed()
    }
  }

  const requestCloseAll = () => {
    if (tabs.some((tab) => tab.dirty)) {
      setPendingClose({ kind: 'all' })
    } else {
      onCloseAll()
    }
  }

  // Atalho de fechar a aba ativa (Ctrl+W por padrão): despachado aqui, onde mora a
  // confirmação de descarte. Não age por trás de um modal.
  const { bindings } = useShortcuts()
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShortcutEventConsumed(event) || event.isComposing) return
      if (findShortcutAction(bindings, event) !== 'closeTab') return
      event.preventDefault()
      const active = tabs.find((tab) => tab.id === activeTabId)
      if (!active || hasOpenModal()) return
      if (isGroupDrag(active.id)) requestCloseMany(selection.map((tab) => tab.id))
      else requestCloseTab(active.id, active.label)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  const confirmPendingClose = () => {
    if (!pendingClose) return
    if (pendingClose.kind === 'tab') onClose(pendingClose.tabId)
    else if (pendingClose.kind === 'others') onCloseOthers(pendingClose.tabId)
    else if (pendingClose.kind === 'unfixed') onCloseUnfixed()
    else if (pendingClose.kind === 'selected') {
      onCloseMany(pendingClose.ids)
      clearSelection()
    } else onCloseAll()
    setPendingClose(null)
  }

  return (
    <div className="rw-open-tabs-row">
      <div
        className="rw-open-tabs"
        role="tablist"
        aria-label={t('workbench.openTabs.ariaLabel')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && selectedIds.size > 0) clearSelection()
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const label = tab.label
          const classNames = ['rw-open-tab']
          if (isActive) classNames.push('rw-open-tab--active')
          if (tab.preview) classNames.push('rw-open-tab--preview')
          if (tab.fixed) classNames.push('rw-open-tab--fixed')
          if (selectedIds.has(tab.id)) classNames.push('rw-open-tab--selected')
          if (draggedId === tab.id || (draggedId !== null && isGroupDrag(draggedId) && selectedIds.has(tab.id))) {
            classNames.push('rw-open-tab--dragging')
          }
          if (dragOverId === tab.id && dragOverEdge) classNames.push(`rw-open-tab--drop-${dragOverEdge}`)

          return (
            <div
              key={tab.id}
              className={classNames.join(' ')}
              data-tab-drop-id={tab.id}
              data-tab-drop-kind="tab"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                const dragLabel = isGroupDrag(tab.id)
                  ? t('workbench.openTabs.selectionDragLabel', { count: selection.length })
                  : label
                startDrag(tab.id, 'tab', dragLabel, event)
              }}
              onContextMenu={(event) => openContextMenu(tab, event)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="rw-open-tab-label"
                onClick={(event) => {
                  if (handleSelectClick(tab.id, event)) return
                  onSelect(tab.id)
                }}
                onDoubleClick={() => {
                  if (tab.preview) onPin(tab.id)
                }}
              >
                {tab.fixed && (
                  <PinIcon size={11} className="rw-open-tab-pin" />
                )}
                {tab.request && (
                  <RequestMethodBadge
                    protocol={tab.request.protocol}
                    method={tab.request.method}
                    className="rw-open-tab-method"
                    aria-hidden
                  />
                )}
                <span className="rw-open-tab-name">{label}</span>
              </button>
              <div className="rw-open-tab-indicator">
                <span
                  className={`rw-open-tab-dirty-dot${tab.dirty ? ' rw-open-tab-dirty-dot--visible' : ''}`}
                  aria-hidden="true"
                />
                <CloseTabButton
                  label={t('workbench.openTabs.closeAria', { name: label })}
                  onClose={() => requestCloseTab(tab.id, label)}
                />
              </div>
            </div>
          )
        })}
        <IconButton
          className="rw-open-tab-new"
          icon={<PlusIcon size={13} />}
          label={t('workbench.openTabs.newTabAria')}
          onClick={(event) => onNewTab(event.currentTarget.getBoundingClientRect())}
        />
      </div>

      <div className="rw-open-tabs-divider" aria-hidden="true" />

      <EnvironmentSelect
        environments={environments}
        activeEnvironmentId={activeEnvironmentId}
        onChange={onEnvironmentChange}
      />

      <DragPreview label={draggedLabel} position={position} />

      {contextMenu && (
        <TabContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onSaveTab={() => onSaveTab(contextMenu.tabId)}
          onCloseTab={() => requestCloseTab(contextMenu.tabId, contextMenu.label)}
          onCloseAllTabs={requestCloseAll}
          onCloseOtherTabs={() => requestCloseOthers(contextMenu.tabId)}
          onCloseUnfixedTabs={requestCloseUnfixed}
          onCloseSelectedTabs={() => requestCloseMany(selection.map((tab) => tab.id))}
          onToggleFix={() => onToggleFix(contextMenu.tabId)}
        />
      )}

      {pendingClose && (
        <DiscardTabModal
          description={
            pendingClose.kind === 'tab'
              ? t('workbench.openTabs.discardModalDescriptionSingle', { name: pendingClose.label })
              : t('workbench.openTabs.discardModalDescriptionMultiple')
          }
          onDiscard={confirmPendingClose}
          onCancel={() => setPendingClose(null)}
        />
      )}
    </div>
  )
})

function CloseTabButton({ label, onClose }: { label: string; onClose: () => void }) {
  const { triggerProps, tooltip } = useTooltip(label)
  return (
    <>
      <button
        type="button"
        className="rw-open-tab-close"
        aria-label={label}
        {...triggerProps}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <CloseIcon size={11} />
      </button>
      {tooltip}
    </>
  )
}
