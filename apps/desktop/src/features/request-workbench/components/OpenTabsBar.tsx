import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { DragPreview } from '../../../shared/DragPreview'
import { useLanguage } from '../../../shared/i18n/use-language'
import { findShortcutAction, isShortcutEventConsumed } from '../../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../../shared/shortcuts/use-shortcuts'
import { hasOpenModal } from '../../../shared/ui/open-modals'
import { usePointerDrag } from '../../../shared/use-pointer-drag'
import type { DropEdge } from '../../../shared/use-pointer-drag'
import { ChevronRightIcon, CloseIcon, PinIcon, PlusIcon } from '../../../shared/ui/icons'
import { IconButton } from '../../../shared/ui/IconButton'
import { MenuItem, MenuSeparator } from '../../../shared/ui/Menu'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import '../../../shared/ui/menu.css'
import type { OpenTabDescriptor } from '../use-open-tabs'
import type { WorkbenchEnvironment } from '../request-workbench.types'
import { arrangeGroupedTabs } from '../tab-groups'
import type { useTabGroups } from '../use-tab-groups'
import { TabGroupEditor } from './TabGroupEditor'
import { TabMenuSurface } from './TabMenuSurface'
import { DiscardTabModal } from './DiscardTabModal'
import { OpenTabsOverflowMenu } from './OpenTabsOverflowMenu'
import { EnvironmentSelect } from './EnvironmentSelect'
import { RequestMethodBadge } from './RequestMethodBadge'
import './open-tabs-bar.css'

interface OpenTabsBarProps {
  tabs: OpenTabDescriptor[]
  tabGroups: ReturnType<typeof useTabGroups>
  activeTabId: string | null
  onSelect: (id: string) => void
  onPin: (id: string) => void
  onClose: (id: string) => void
  onCloseAll: () => void
  onCloseOthers: (id: string) => void
  onCloseUnfixed: () => void
  onCloseMany: (ids: string[]) => void
  onToggleFix: (id: string) => void
  /** Open the request type popover anchored to the plus button rectangle. */
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
  /** Number of selected tabs when the menu opens on the group; zero outside a multi-selection. */
  selectionCount: number
  x: number
  y: number
}

/** Tab closing action awaiting confirmation because an affected tab has unsaved changes. */
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
  canGroup,
  grouped,
  onGroup,
  onUngroup,
}: {
  menu: TabContextMenuState
  canGroup: boolean
  grouped: boolean
  onGroup: () => void
  onUngroup: () => void
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

  return (
    <TabMenuSurface x={menu.x} y={menu.y} label={t('workbench.openTabs.contextMenuAria', { name: menu.label })} onClose={onClose}>
      {canGroup && <MenuItem label={t('workbench.tabGroups.add')} shortcutAction="groupTabs" onSelect={onGroup} />}
      {grouped && <MenuItem label={t('workbench.tabGroups.remove')} onSelect={() => { onUngroup(); onClose() }} />}
      {(canGroup || grouped) && <MenuSeparator />}
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
          shortcutAction="saveRequest"
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
        <MenuSeparator />
        <MenuItem
          label={t('workbench.openTabs.closeTabMenuItem')}
          shortcutAction="closeTab"
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
    </TabMenuSurface>
  )
}

export const OpenTabsBar = memo(function OpenTabsBar({
  tabs: baseTabs,
  tabGroups,
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
  const groups = tabGroups.groups
  const tabs = arrangeGroupedTabs(baseTabs, groups)
  const membership = new Map(groups.flatMap((group) => group.tabIds.map((id) => [id, group] as const)))
  const visibleTabs = tabs.filter((tab) => !membership.get(tab.id)?.collapsed)
  const [groupPicker, setGroupPicker] = useState<{ ids: string[]; x: number; y: number } | null>(null)
  const [groupEditor, setGroupEditor] = useState<{ id: string; x: number; y: number } | null>(null)
  const editingGroup = groups.find((group) => group.id === groupEditor?.id)
  const previousActiveRef = useRef(activeTabId)
  const hadTabsRef = useRef(baseTabs.length > 0)
  const barRef = useRef<HTMLDivElement>(null)
  // Tabs shrink down to their minimum width first; once the strip still overflows, the dropdown lists every tab.
  const [overflowing, setOverflowing] = useState(false)
  // Opening, renaming or collapsing tabs changes the content width without resizing the strip.
  useLayoutEffect(() => setOverflowing(isStripOverflowing(barRef.current)), [baseTabs, groups])
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const observer = new ResizeObserver(() => setOverflowing(isStripOverflowing(bar)))
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])
  // Reveal tabs activated from the sidebar, search, shortcuts or a close action.
  useEffect(() => {
    if (previousActiveRef.current === activeTabId) return
    previousActiveRef.current = activeTabId
    if (!hadTabsRef.current) { hadTabsRef.current = baseTabs.length > 0; return }
    const group = activeTabId ? membership.get(activeTabId) : undefined
    if (group?.collapsed) tabGroups.updateGroup(group.id, { collapsed: false })
    barRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  })
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  /** Ctrl/Cmd+click toggles a tab; Shift+click selects a range from the anchor (initially the active tab).
   * IDs may outlive closed tabs; `selection` filters existing tabs in bar order. */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const selection = tabs.filter((tab) => selectedIds.has(tab.id))
  const isGroupDrag = (id: string) => selection.length > 1 && selectedIds.has(id)

  const clearSelection = () => {
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  /** Return true when the click changes selection and should not activate the tab. */
  const handleSelectClick = (id: string, event: ReactMouseEvent): boolean => {
    const additive = event.ctrlKey || event.metaKey
    const anchor = anchorId !== null && visibleTabs.some((tab) => tab.id === anchorId) ? anchorId : activeTabId
    if (event.shiftKey && anchor !== null) {
      const from = visibleTabs.findIndex((tab) => tab.id === anchor)
      const to = visibleTabs.findIndex((tab) => tab.id === id)
      if (from !== -1 && to !== -1) {
        const range = visibleTabs.slice(Math.min(from, to), Math.max(from, to) + 1).map((tab) => tab.id)
        setSelectedIds((current) => new Set(additive ? [...current, ...range] : range))
        setAnchorId(anchor)
        return true
      }
    }
    if (additive || event.shiftKey) {
      setSelectedIds((current) => {
        const next = new Set(current.size === 0 && activeTabId !== null && visibleTabs.some((tab) => tab.id === activeTabId) ? [activeTabId] : current)
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

  const { draggedId, draggedLabel, dragOverId, dragOverEdge, position, startDrag } = usePointerDrag<'tab' | 'group'>({
    dropTargetAttribute: 'data-tab-drop-id',
    dropKindAttribute: 'data-tab-drop-kind',
    orientation: 'horizontal',
    onDrop: (dragged, target, edge) => {
      const ids = isGroupDrag(dragged.id) ? selection.map((tab) => tab.id) : [dragged.id]
      if (target.kind === 'group') {
        tabGroups.moveTabs(ids, target.id)
        return
      }
      const draggedTab = tabs.find((tab) => tab.id === dragged.id)
      const targetTab = tabs.find((tab) => tab.id === target.id)
      if (!draggedTab || !targetTab || draggedTab.fixed !== targetTab.fixed) return
      const targetGroup = membership.get(target.id)
      const fromGroup = membership.get(dragged.id)
      if (targetGroup || fromGroup) tabGroups.moveTabs(ids, targetGroup?.id ?? null, target.id, edge)
      if (!targetGroup) {
        if (ids.length > 1) onReorderGroup(ids, target.id, edge)
        else onReorder(dragged.id, target.id, edge)
      }
    },
  })

  const openContextMenu = (tab: OpenTabDescriptor, event: ReactMouseEvent) => {
    event.preventDefault()
    // Right-clicking outside the selection clears it; on a selected tab, the menu acts on the group.
    const inGroup = selection.length > 1 && selectedIds.has(tab.id)
    if (!inGroup && selectedIds.size > 0) clearSelection()
    setGroupPicker(null)
    setGroupEditor(null)
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

  /** Close immediately when affected tabs have no unsaved changes; otherwise request confirmation. */
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

  const createGroupAt = (ids: string[], point: { x: number; y: number }) => {
    const id = tabGroups.createGroup(ids, t('workbench.tabGroups.defaultName'))
    if (id) setGroupEditor({ id, ...point })
    setGroupPicker(null)
    clearSelection()
  }

  // The bar owns selection and close confirmations, so it dispatches both tab shortcuts.
  const { bindings } = useShortcuts()
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShortcutEventConsumed(event) || event.isComposing) return
      const action = findShortcutAction(bindings, event)
      if (action !== 'closeTab' && action !== 'groupTabs') return
      event.preventDefault()
      if (hasOpenModal()) return
      const active = tabs.find((tab) => tab.id === activeTabId)
      if (action === 'groupTabs') {
        if (event.repeat || event.target instanceof Element && event.target.closest('.rw-tab-context-menu')) return
        const targets = (selection.length ? selection : active ? [active] : []).filter((tab) => !tab.fixed && tab.fixable !== false)
        if (!targets.length) return
        const targetGroup = membership.get(targets[0].id)
        const anchorId = targetGroup?.collapsed ? targetGroup.id : targets[0].id
        const anchors = barRef.current?.querySelectorAll<HTMLElement>('[data-tab-drop-id]') ?? []
        const anchor = [...anchors].find((element) => element.dataset.tabDropId === anchorId)
        const rect = (anchor ?? barRef.current)?.getBoundingClientRect()
        if (!rect) return
        const point = { x: rect.left, y: rect.bottom + 6 }
        setContextMenu(null)
        setGroupEditor(null)
        const ids = targets.map((tab) => tab.id)
        if (groups.length === 0) createGroupAt(ids, point)
        else setGroupPicker({ ids, ...point })
        return
      }
      if (!active) return
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
      <div className="rw-open-tabs-area">
      <div
        ref={barRef}
        className="rw-open-tabs"
        role="tablist"
        aria-label={t('workbench.openTabs.ariaLabel')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && selectedIds.size > 0) clearSelection()
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const at = visibleTabs.findIndex((tab) => tab.id === activeTabId)
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1
            : (at + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length
          const next = visibleTabs[index]
          if (next) {
            onSelect(next.id)
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
          }
        }}
      >
        {tabs.map((tab) => {
          const group = membership.get(tab.id)
          const groupCountLabel = group ? t(group.tabIds.length === 1 ? 'workbench.tabGroups.singleTab' : 'workbench.tabGroups.tabCount', { count: group.tabIds.length }) : ''
          const firstInGroup = group?.tabIds[0] === tab.id
          const lastInGroup = group?.tabIds.at(-1) === tab.id
          const groupStyle = group ? { '--tab-group-color': `var(--label-${group.color})` } as CSSProperties : undefined
          const isActive = tab.id === activeTabId
          const label = tab.label
          const classNames = ['rw-open-tab']
          if (group) classNames.push('rw-open-tab--grouped')
          if (lastInGroup) classNames.push('rw-open-tab--group-end')
          if (isActive) classNames.push('rw-open-tab--active')
          if (tab.preview) classNames.push('rw-open-tab--preview')
          if (tab.fixed) classNames.push('rw-open-tab--fixed')
          if (selectedIds.has(tab.id)) classNames.push('rw-open-tab--selected')
          if (draggedId === tab.id || (draggedId !== null && isGroupDrag(draggedId) && selectedIds.has(tab.id))) {
            classNames.push('rw-open-tab--dragging')
          }
          if (dragOverId === tab.id && dragOverEdge) classNames.push(`rw-open-tab--drop-${dragOverEdge}`)

          return (
            <Fragment key={tab.id}>
            {group && firstInGroup && (
              <div
                className={`rw-tab-group${group.collapsed ? ' rw-tab-group--collapsed' : ''}${group.collapsed && group.tabIds.includes(activeTabId ?? '') ? ' rw-tab-group--active' : ''}${dragOverId === group.id ? ' rw-tab-group--drop' : ''}`}
                style={groupStyle}
                data-tab-drop-id={group.id}
                data-tab-drop-kind="group"
                onContextMenu={(event) => {
                  event.preventDefault()
                  setContextMenu(null)
                  setGroupPicker(null)
                  setGroupEditor({ id: group.id, x: event.clientX, y: event.clientY })
                }}
              >
                <button
                  type="button"
                  className="rw-tab-group-label"
                  aria-expanded={!group.collapsed}
                  aria-label={t(group.collapsed ? 'workbench.tabGroups.expandAria' : 'workbench.tabGroups.collapseAria', { name: group.name, tabs: groupCountLabel })}
                  onClick={() => { clearSelection(); tabGroups.updateGroup(group.id, { collapsed: !group.collapsed }) }}
                >
                  <ChevronRightIcon size={11} className="rw-tab-group-chevron" />
                  <span className="rw-tab-group-name">{group.name}</span>
                  <span className="rw-tab-group-count">{group.tabIds.length}</span>
                  {group.collapsed && group.tabIds.some((id) => tabs.some((member) => member.id === id && member.dirty)) && <span className="rw-tab-group-dirty" aria-label={t('workbench.tabGroups.unsaved')} />}
                </button>
              </div>
            )}
            {!group?.collapsed && <div
              className={classNames.join(' ')}
              style={groupStyle}
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
                tabIndex={isActive || !visibleTabs.some((candidate) => candidate.id === activeTabId) && visibleTabs[0]?.id === tab.id ? 0 : -1}
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
            </div>}
            </Fragment>
          )
        })}
      </div>
        <IconButton
          className="rw-open-tab-new"
          icon={<PlusIcon size={13} />}
          label={t('workbench.openTabs.newTabAria')}
          onClick={(event) => onNewTab(event.currentTarget.getBoundingClientRect())}
        />
        {overflowing && <OpenTabsOverflowMenu tabs={tabs} activeTabId={activeTabId} onSelect={onSelect} />}
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
          canGroup={(contextMenu.selectionCount > 1 ? selection : tabs.filter((tab) => tab.id === contextMenu.tabId)).some((tab) => !tab.fixed && tab.fixable !== false)}
          grouped={(contextMenu.selectionCount > 1 ? selection : tabs.filter((tab) => tab.id === contextMenu.tabId)).some((tab) => membership.has(tab.id))}
          onGroup={() => {
            setGroupPicker({ ids: contextMenu.selectionCount > 1 ? selection.map((tab) => tab.id) : [contextMenu.tabId], x: contextMenu.x, y: contextMenu.y })
            setContextMenu(null)
          }}
          onUngroup={() => tabGroups.moveTabs(contextMenu.selectionCount > 1 ? selection.map((tab) => tab.id) : [contextMenu.tabId], null)}
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

      {groupPicker && (
        <TabMenuSurface x={groupPicker.x} y={groupPicker.y} label={t('workbench.tabGroups.add')} onClose={() => setGroupPicker(null)}>
          <MenuItem label={t('workbench.tabGroups.new')} icon={<PlusIcon size={13} />} onSelect={() => {
            createGroupAt(groupPicker.ids, { x: groupPicker.x, y: groupPicker.y })
          }} />
          {groups.length > 0 && <MenuSeparator />}
          {groups.map((group) => (
            <MenuItem key={group.id} label={group.name} icon={<span className="rw-tab-group-dot" style={{ background: `var(--label-${group.color})` }} />} onSelect={() => {
              tabGroups.moveTabs(groupPicker.ids, group.id)
              setGroupPicker(null)
              clearSelection()
            }} />
          ))}
        </TabMenuSurface>
      )}

      {groupEditor && editingGroup && (
        <TabGroupEditor
          key={editingGroup.id}
          group={editingGroup}
          x={groupEditor.x}
          y={groupEditor.y}
          onClose={() => setGroupEditor(null)}
          onUpdate={(patch) => tabGroups.updateGroup(editingGroup.id, patch)}
          onUngroup={() => tabGroups.ungroup(editingGroup.id)}
          onCloseTabs={() => requestCloseMany(editingGroup.tabIds)}
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

function isStripOverflowing(strip: HTMLElement | null): boolean {
  return strip !== null && strip.scrollWidth > strip.clientWidth + 1
}

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
