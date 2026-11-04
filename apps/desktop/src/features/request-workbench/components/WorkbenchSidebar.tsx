import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthenticationInput } from '../../../bindings/execute-graphql-request'
import type { ItemChangeKind, StructuredFileChangesDto } from '../../../bindings/gitlab-types'
import type { FocusEvent, MouseEvent as ReactMouseEvent, ReactNode, RefCallback } from 'react'
import { EnvironmentsPanel } from '../../environments/EnvironmentsPanel'
import '../../environments/environments.css'
import { FlowsPanel } from '../../flows/FlowsPanel'
import type { FlowTemplateId } from '../../flows/flow-templates'
import { ValueMonitorsPanel, type ValueMonitorsPanelProps } from '../../value-monitors/ValueMonitorsPanel'
import { SettingsMenu, type SettingsCategory } from '../../settings-menu/SettingsMenu'
import type { BulkRow } from '../../../shared/bulk-edit'
import { useLanguage } from '../../../shared/i18n/use-language'
import { EXTENSION_SIDEBAR_MODULES } from '../../../extensions/registry'
import { CheckIcon, PanelLeftIcon, ClockIcon, ComponentsIcon, GitIcon, MonitorIcon, RobotIcon, VariablesIcon } from '../../../shared/ui/icons'
import { MockServersPanel } from '../../mock-servers/MockServersPanel'
import '../../mock-servers/mock-servers.css'
import { MenuItem } from '../../../shared/ui/Menu'
import { Tooltip } from '../../../shared/ui/Tooltip'
import { FEATURE_FLAGS } from '../../../shared/feature-flags'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { CollectionLabelDto, LabelColor, ScopedVariableDto } from '../../../bindings/list-collections'
import type { HistoryEntrySummaryDto } from '../../../bindings/list-history'
import type { FlowFolderDto } from '../../../bindings/list-flows'
import type { ActiveComponentKind } from '../history'
import type { SiblingEdge } from '../../../shared/use-pointer-drag'
import type { FlowState } from '../../flows/flows.types'
import type { ImportOutcome } from '../use-collections-state'
import type { ImportVariableSelectionDto, PrepareImportResult } from '../../../bindings/prepared-import'
import type { ExistingEnvironmentTarget } from '../import-variables'
import { CollectionsPanel, type CollectionsCommand } from './CollectionsPanel'
import { ComponentKindSelect } from './ComponentKindSelect'
import type { ComponentKind } from './ComponentKindSelect'
import { HistoryPanel } from './HistoryPanel'
import type { EnvironmentState, VariableRow } from '../../environments/environments.types'
import type { AlphabeticalSortDirection, RequestContent, RequestProtocol, TreeNode } from '../collection-tree'
import { VersionControlPanel, type VersionReviewTarget } from '../../version-control/VersionControlPanel'
import { logger } from '../../../shared/logging/logger'
import type { VersionControl } from '../../version-control/use-version-control'
import {
  loadHiddenSidebarModules,
  loadSidebarModuleOrder,
  moveSidebarModule,
  persistHiddenSidebarModules,
  persistSidebarModuleOrder,
  type SidebarModuleId,
} from '../sidebar-modules'
import { DragPreview } from '../../../shared/DragPreview'
import { usePointerDrag } from '../../../shared/use-pointer-drag'
import './workbench-modules.css'

export type SidebarTab = SidebarModuleId

/** Modules whose panel pins its toolbar over a scrolling body (`.sidebar-panel-layout`).
 * The others, extension modules included, scroll as a whole inside the tab panel. */
const PINNED_TOOLBAR_MODULES: ReadonlySet<SidebarTab> = new Set<SidebarTab>(['components', 'history', 'git', 'agent'])

interface EnvironmentsPanelSlice {
  environments: EnvironmentState[]
  unreadableSecrets: string[]
  activeEnvironmentId: string | null
  onSelectEnvironment: (id: string) => void
  onAddEnvironment: () => void
  onRemoveEnvironment: (id: string) => void
  onDuplicateEnvironment: (id: string) => void
  onRenameEnvironment: (id: string, name: string) => void
  onMoveEnvironment: (draggedId: string, targetId: string, edge: SiblingEdge) => void
  onAddVariable: (environmentId: string) => void
  onUpdateVariable: (environmentId: string, variableId: string, patch: Partial<Omit<VariableRow, 'id'>>) => void
  onRemoveVariable: (environmentId: string, variableId: string) => void
  onMoveVariable: (environmentId: string, draggedId: string, targetId: string, edge: SiblingEdge) => void
  onReplaceVariables: (environmentId: string, rows: BulkRow[]) => void
}

interface CollectionsPanelSlice {
  collections: TreeNode[]
  expandedIds: Set<string>
  openRequestId: string | null
  onToggleExpanded: (id: string) => void
  onCollapseAll: () => void
  onExpandAll: () => void
  onRevealRequest: (id: string) => void
  onAddCollection: () => string
  onAddFolder: (parentId: string) => string
  onAddRequest: (parentId: string, name: string, protocol: RequestProtocol) => { id: string; name: string }
  onCreateStandaloneRequest: (anchor: DOMRect) => void
  onOpenRequest: (id: string, content: RequestContent, name: string) => void
  onPinRequest: (id: string) => void
  onRename: (id: string, name: string) => void
  onUpdateAuthentication: (id: string, authentication: AuthenticationInput) => void
  onUpdateVariables: (id: string, variables: ScopedVariableDto[]) => void
  favoriteIds: ReadonlySet<string>
  onSetFavorites: (ids: string[], favorite: boolean, existingIds: string[]) => void
  onAssignLabel: (ids: string[], label: CollectionLabelDto, assigned: boolean) => void
  onRenameLabel: (oldName: string, newName: string) => void
  onRecolorLabel: (name: string, color: LabelColor) => void
  onRemoveLabel: (name: string) => void
  onRemove: (id: string) => void
  onRemoveMany: (ids: string[]) => void
  onMoveMany: (ids: string[], targetParentId: string) => void
  onDuplicateRequest: (id: string) => { id: string; name: string; content: RequestContent }
  onMoveRequest: (id: string, targetParentId: string) => void
  onReorderRequest: (id: string, targetId: string, edge: SiblingEdge) => void
  onMoveFolder: (id: string, targetParentId: string) => void
  onReorderFolder: (id: string, targetId: string, edge: SiblingEdge) => void
  onReorderCollections: (id: string, targetId: string, edge: SiblingEdge) => void
  onSortChildren: (id: string, direction: AlphabeticalSortDirection) => void
  onExportCollection: (id: string) => void
  onExportCollections: (ids: string[]) => void
  onRunCollection: (id: string) => void
  onGenerateFlow: (id: string) => void
  onExportWebclient: (id: string) => void
  onDropOnFlow: (itemIds: string[], flowId: string, point: { x: number; y: number }) => void
  onExportAll: () => void
  onPrepareImportFromPath: (path: string) => Promise<PrepareImportResult>
  onPrepareImportFromUrl: (url: string) => Promise<PrepareImportResult>
  onPrepareImportFromText: (content: string) => Promise<PrepareImportResult>
  onCommitPreparedImport: (id: string, includeDocumentation: boolean, variables?: ImportVariableSelectionDto[]) => Promise<ImportOutcome>
  importEnvironmentTargets: ExistingEnvironmentTarget[]
  environmentVariables: EnvironmentVariableDto[]
  command: CollectionsCommand | null
  onCommandHandled: () => void
}

interface HistoryPanelSlice {
  entries: HistoryEntrySummaryDto[]
  loaded: boolean
  activeComponentKind: ActiveComponentKind
  onRestore: (id: string) => void
  onRefresh: () => void
}

interface FlowsPanelSlice {
  flows: FlowState[]
  folders: FlowFolderDto[]
  saveError: string | null
  onAddFolder: () => string
  onRenameFolder: (id: string, name: string) => void
  onRemoveFolder: (id: string) => void
  onMoveFolder: (id: string, targetId: string, edge: SiblingEdge) => void
  onMoveFlowToFolder: (flowId: string, folderId: string | null) => void
  onAddFlow: (folderId?: string) => string
  onAddFlowFromTemplate: (templateId: FlowTemplateId, folderId?: string) => string
  onAddLoadFlow?: (folderId?: string) => string
  onImportLoadTest?: () => void
  onRenameFlow: (id: string, name: string) => void
  onRemoveFlow: (id: string) => void
  onMoveFlow: (draggedId: string, targetId: string, edge: SiblingEdge) => void
  onOpenFlow: (id: string) => void
}

interface MockServersPanelSlice {
  rootPath: string
  /** Server of the active tab, highlighted in the list like open requests. */
  activeServerId: string | null
  onOpenServer: (serverId: string, label: string) => void
}

interface WorkbenchSidebarProps {
  documentsPanel?: ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
  environments: EnvironmentsPanelSlice
  collections: CollectionsPanelSlice
  history: HistoryPanelSlice
  flows: FlowsPanelSlice
  valueMonitors: ValueMonitorsPanelProps
  mockServers: MockServersPanelSlice
  /** Item id to unpushed local change kind; marks component rows with M/A/D. */
  changeMarkers: Map<string, ItemChangeKind>
  settingsOpen: boolean
  settingsCategory: SettingsCategory
  onSettingsOpenChange: (open: boolean) => void
  onOpenReleaseNotes?: () => void
  activeTab?: SidebarTab
  onActiveTabChange?: (tab: SidebarTab) => void
  versionControl: {
    rootPath: string
    vc: VersionControl
    onOpenSettings: () => void
    onReview: (target: VersionReviewTarget) => void
    onPull: () => void
    onResolveConflict: (fileName: string, changes: StructuredFileChangesDto) => void
  }
  /** The agent chat docked on the left (spec 0143): a module named this, whose panel only holds the
   * place the workbench moves the chat into, so the chat itself never remounts. */
  agentModuleLabel?: string | null
  /** Receives that place while the module is shown, and `null` when it goes away. */
  agentSlotRef?: RefCallback<HTMLDivElement>
}

interface SidebarModuleNavigationItem {
  id: SidebarTab
  label: string
  icon: ReactNode
}

interface SidebarContextMenuState {
  module: SidebarTab | null
  x: number
  y: number
}

/** Activity bar context menu, keeping hidden modules accessible without opening Settings. */
function SidebarModulesContextMenu({
  menu,
  navigation,
  isModuleVisible,
  canHideModule,
  canMoveUp,
  canMoveDown,
  onToggleModule,
  onMoveModule,
  onClose,
}: {
  menu: SidebarContextMenuState
  navigation: SidebarModuleNavigationItem[]
  isModuleVisible: (module: SidebarTab) => boolean
  canHideModule: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onToggleModule: (module: SidebarTab) => void
  onMoveModule: (module: SidebarTab, direction: -1 | 1) => void
  onClose: () => void
}) {
  const { t } = useLanguage()
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedModule = menu.module === null ? null : navigation.find((item) => item.id === menu.module)

  useEffect(() => {
    menuRef.current?.focus()
  }, [])

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose()
  }

  return (
    <div
      ref={menuRef}
      className="ui-menu workbench-module-context-menu"
      role="menu"
      aria-label={
        selectedModule
          ? t('workbench.modules.contextMenuAria', { name: selectedModule.label })
          : t('workbench.modules.listContextMenuAria')
      }
      style={{ left: menu.x, top: menu.y }}
      tabIndex={-1}
      onBlur={closeOnBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      {selectedModule && (
        <>
          <MenuItem
            label={t('workbench.modules.hide', { name: selectedModule.label })}
            disabled={!canHideModule}
            autoFocus
            onSelect={() => {
              onToggleModule(selectedModule.id)
              onClose()
            }}
          />
          <MenuItem
            label={t('workbench.modules.moveUp', { name: selectedModule.label })}
            disabled={!canMoveUp}
            onSelect={() => {
              onMoveModule(selectedModule.id, -1)
              onClose()
            }}
          />
          <MenuItem
            label={t('workbench.modules.moveDown', { name: selectedModule.label })}
            disabled={!canMoveDown}
            onSelect={() => {
              onMoveModule(selectedModule.id, 1)
              onClose()
            }}
          />
          <div className="workbench-module-context-menu-divider" role="separator" />
        </>
      )}
      {navigation.map((item) => {
        const visible = isModuleVisible(item.id)
        return (
          <button
            key={item.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={visible}
            className="ui-menu-item workbench-module-visibility-item"
            disabled={visible && !canHideModule}
            onClick={() => {
              onToggleModule(item.id)
              onClose()
            }}
          >
            <span className="workbench-module-visibility-mark" aria-hidden="true">
              {visible && <CheckIcon size={12} />}
            </span>
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export const WorkbenchSidebar = memo(function WorkbenchSidebar({
  collapsed,
  onToggleCollapsed,
  environments,
  collections,
  history,
  flows,
  valueMonitors,
  mockServers,
  changeMarkers,
  settingsOpen,
  settingsCategory,
  onSettingsOpenChange,
  onOpenReleaseNotes,
  activeTab: controlledActiveTab,
  onActiveTabChange,
  versionControl,
  agentModuleLabel = null,
  agentSlotRef,
  documentsPanel,
}: WorkbenchSidebarProps) {
  const { t, language } = useLanguage()
  const [internalActiveTab, setInternalActiveTab] = useState<SidebarTab>('components')
  const [hiddenModules, setHiddenModules] = useState(loadHiddenSidebarModules)
  const [moduleOrder, setModuleOrder] = useState(loadSidebarModuleOrder)
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null)
  const activeTab = controlledActiveTab ?? internalActiveTab
  const setActiveTab = (tab: SidebarTab) => {
    if (tab !== activeTab) logger.info('sidebar', `módulo: ${tab}`)
    setInternalActiveTab(tab)
    onActiveTabChange?.(tab)
  }
  const [componentKind, setComponentKind] = useState<ComponentKind>('collections')
  // Collection shortcut commands bring the collections panel in front of flows.
  const [seenCollectionsCommand, setSeenCollectionsCommand] = useState<CollectionsCommand | null>(null)
  if (collections.command !== seenCollectionsCommand) {
    setSeenCollectionsCommand(collections.command)
    if (collections.command) setComponentKind('collections')
  }
  const navigationRefs = useRef<Array<HTMLButtonElement | null>>([])

  const availableNavigation = useMemo(
    () =>
      [
        { id: 'components', label: t('components.tabLabel'), icon: <ComponentsIcon size={19} /> },
        { id: 'environments', label: t('environments.ariaLabel'), icon: <VariablesIcon size={19} /> },
        ...(FEATURE_FLAGS.valueMonitors ? [{ id: 'monitors' as const, label: t('monitors.title'), icon: <MonitorIcon size={19} /> }] : []),
        { id: 'documents', label: t('documents.label'), icon: <PanelLeftIcon size={19} /> },
        { id: 'history', label: t('environments.historyTab'), icon: <ClockIcon size={19} /> },
        ...(FEATURE_FLAGS.gitlab || FEATURE_FLAGS.onedrive ? [{ id: 'git' as const, label: t('vc.panel.title'), icon: <GitIcon size={19} /> }] : []),
        ...EXTENSION_SIDEBAR_MODULES.map((module) => ({ id: module.id, label: module.label[language], icon: module.icon })),
        ...(agentModuleLabel !== null ? [{ id: 'agent' as const, label: agentModuleLabel, icon: <RobotIcon size={19} /> }] : []),
      ] satisfies SidebarModuleNavigationItem[],
    [t, language, agentModuleLabel],
  )
  const allNavigation = useMemo(
    () => [...availableNavigation].sort((a, b) => moduleOrder.indexOf(a.id) - moduleOrder.indexOf(b.id)),
    [availableNavigation, moduleOrder],
  )
  // The agent module follows where the chat is docked, not the visibility preference.
  const navigation = useMemo(() => allNavigation.filter((item) => item.id === 'agent' || !hiddenModules.has(item.id)), [allNavigation, hiddenModules])
  const hideableNavigation = useMemo(() => allNavigation.filter((item) => item.id !== 'agent'), [allNavigation])
  // If preferences hide the default active tab, show the first visible one without setting state during render.
  const visibleActiveTab = navigation.some((item) => item.id === activeTab) ? activeTab : navigation[0].id

  const toggleModuleVisibility = (module: SidebarTab) => {
    const isVisible = !hiddenModules.has(module)
    if (isVisible && navigation.length === 1) return

    const next = new Set(hiddenModules)
    if (isVisible) {
      next.add(module)
      if (visibleActiveTab === module) setActiveTab(navigation.find((item) => item.id !== module)!.id)
    } else {
      next.delete(module)
    }
    persistHiddenSidebarModules(next)
    setHiddenModules(next)
  }

  const reorderModule = (draggedId: SidebarTab, targetId: SidebarTab, edge: 'before' | 'after') => {
    const next = moveSidebarModule(moduleOrder, draggedId, targetId, edge)
    persistSidebarModuleOrder(next)
    setModuleOrder(next)
  }

  /** Move one step among visible modules, preserving hidden modules' positions. */
  const stepModule = (module: SidebarTab, direction: -1 | 1) => {
    const neighbor = navigation[navigation.findIndex((item) => item.id === module) + direction]
    if (neighbor) reorderModule(module, neighbor.id, direction === -1 ? 'before' : 'after')
  }

  const { draggedId, draggedLabel, dragOverId, dragOverEdge, position, startDrag } = usePointerDrag<'module'>({
    dropTargetAttribute: 'data-module-drop-id',
    dropKindAttribute: 'data-module-drop-kind',
    orientation: 'vertical',
    onDrop: (dragged, target, edge) => reorderModule(dragged.id as SidebarTab, target.id as SidebarTab, edge === 'after' ? 'after' : 'before'),
  })

  // Dropping onto the same button fires a click; suppress it to avoid collapsing the panel.
  const suppressClickRef = useRef(false)
  useEffect(() => {
    if (draggedId !== null) {
      suppressClickRef.current = true
      return
    }
    const timer = window.setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
    return () => window.clearTimeout(timer)
  }, [draggedId])

  const activeNavigation = navigation.find((item) => item.id === visibleActiveTab) ?? navigation[0]
  const asideLabel =
    visibleActiveTab === 'components'
      ? componentKind === 'flows'
        ? t('flows.subTabLabel')
        : componentKind === 'mockServers'
          ? t('mockServers.title')
          : t('environments.collectionsTab')
      : activeNavigation.label

  const selectTab = (tab: SidebarTab) => {
    if (tab === visibleActiveTab && !collapsed) {
      onToggleCollapsed()
      return
    }
    setActiveTab(tab)
    if (collapsed) onToggleCollapsed()
  }

  const focusNavigationItem = (index: number) => {
    const wrapped = (index + navigation.length) % navigation.length
    const item = navigation[wrapped]
    setActiveTab(item.id)
    if (collapsed) onToggleCollapsed()
    navigationRefs.current[wrapped]?.focus()
  }

  return (
    <div className="workbench-navigation">
      <nav
        className="workbench-rail"
        aria-label={t('workbench.navigationAria')}
        onContextMenu={(event: ReactMouseEvent<HTMLElement>) => {
          // Buttons have their own context menus; the empty rail shows only module visibility options.
          if ((event.target as HTMLElement).closest('button')) return
          event.preventDefault()
          setContextMenu({ module: null, x: event.clientX, y: event.clientY })
        }}
      >
        <div className="workbench-rail-items" role="tablist" aria-orientation="vertical">
          {navigation.map((item, index) => (
            <Tooltip key={item.id} label={item.label} side="right" className="workbench-rail-tooltip" hoverOnly>
              <button
                type="button"
                ref={(element) => {
                  navigationRefs.current[index] = element
                }}
                role="tab"
                id={`sidebar-tab-${item.id}`}
                aria-controls={`sidebar-panel-${item.id}`}
                aria-selected={visibleActiveTab === item.id}
                aria-label={item.label}
                tabIndex={visibleActiveTab === item.id ? 0 : -1}
                className={[
                  'workbench-rail-button',
                  draggedId === item.id ? 'workbench-rail-button--dragging' : '',
                  dragOverId === item.id && dragOverEdge ? `workbench-rail-button--drop-${dragOverEdge}` : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-module-drop-id={item.id}
                data-module-drop-kind="module"
                onPointerDown={(event) => {
                  if (event.button === 0) startDrag(item.id, 'module', item.label, event)
                }}
                onClick={() => {
                  if (suppressClickRef.current) return
                  selectTab(item.id)
                }}
                onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  event.preventDefault()
                  setContextMenu({ module: item.id, x: event.clientX, y: event.clientY })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    focusNavigationItem(index + 1)
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    focusNavigationItem(index - 1)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    focusNavigationItem(0)
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    focusNavigationItem(navigation.length - 1)
                  }
                }}
              >
                {item.icon}
                {item.id === 'git' && versionControl.vc.counts.local > 0 && <span className="workbench-rail-badge">{versionControl.vc.counts.local}</span>}
              </button>
            </Tooltip>
          ))}
        </div>
        <div className="workbench-rail-footer">
          <SettingsMenu
            initialCategory={settingsCategory}
            open={settingsOpen}
            onOpenChange={onSettingsOpenChange}
            onOpenReleaseNotes={onOpenReleaseNotes}
            onHistoryRetentionChange={history.onRefresh}
          />
        </div>
      </nav>

      <DragPreview label={draggedLabel} position={position} />

      {contextMenu && (
        <SidebarModulesContextMenu
          menu={contextMenu}
          navigation={hideableNavigation}
          isModuleVisible={(module) => !hiddenModules.has(module)}
          canHideModule={contextMenu.module !== 'agent' && navigation.length > 1}
          canMoveUp={navigation.findIndex((item) => item.id === contextMenu.module) > 0}
          canMoveDown={(() => {
            const index = navigation.findIndex((item) => item.id === contextMenu.module)
            return index !== -1 && index < navigation.length - 1
          })()}
          onToggleModule={toggleModuleVisibility}
          onMoveModule={stepModule}
          onClose={() => setContextMenu(null)}
        />
      )}

      {!collapsed && (
        <aside className="env-sidebar" aria-label={asideLabel}>
          {/* The chat brings its own header. */}
          {visibleActiveTab !== 'agent' && (
            <header className="workbench-sidebar-header">
              {visibleActiveTab === 'components' ? (
                <ComponentKindSelect value={componentKind} onChange={setComponentKind} />
              ) : (
                <span key={visibleActiveTab} className="workbench-sidebar-title">
                  {activeNavigation.label}
                </span>
              )}
            </header>
          )}
          <div
            className={PINNED_TOOLBAR_MODULES.has(visibleActiveTab) ? 'env-tabpanel env-tabpanel--pinned-toolbar' : 'env-tabpanel'}
            id={`sidebar-panel-${visibleActiveTab}`}
            role="tabpanel"
            aria-labelledby={`sidebar-tab-${visibleActiveTab}`}
          >
            {visibleActiveTab === 'components' && componentKind === 'collections' && <CollectionsPanel {...collections} changeMarkers={changeMarkers} />}
            {visibleActiveTab === 'components' && componentKind === 'flows' && <FlowsPanel {...flows} changeMarkers={changeMarkers} />}
            {visibleActiveTab === 'components' && componentKind === 'mockServers' && <MockServersPanel rootPath={mockServers.rootPath} activeServerId={mockServers.activeServerId} onOpenServer={mockServers.onOpenServer} />}
            {visibleActiveTab === 'history' && (
              <HistoryPanel
                entries={history.entries}
                loaded={history.loaded}
                activeComponentKind={history.activeComponentKind}
                onRestore={history.onRestore}
                onRefresh={history.onRefresh}
              />
            )}
            {visibleActiveTab === 'documents' && documentsPanel}
            {visibleActiveTab === 'environments' && <EnvironmentsPanel {...environments} />}
            {visibleActiveTab === 'monitors' && FEATURE_FLAGS.valueMonitors && <ValueMonitorsPanel {...valueMonitors} />}
            {visibleActiveTab === 'git' && (FEATURE_FLAGS.gitlab || FEATURE_FLAGS.onedrive) && <VersionControlPanel rootPath={versionControl.rootPath} vc={versionControl.vc} onOpenSettings={versionControl.onOpenSettings} onReview={versionControl.onReview} onPull={versionControl.onPull} onResolveConflict={versionControl.onResolveConflict} embedded />}
            {EXTENSION_SIDEBAR_MODULES.map((module) => visibleActiveTab === module.id && <module.Panel key={module.id} />)}
            {visibleActiveTab === 'agent' && <div ref={agentSlotRef} className="agent-sidebar-slot" />}
          </div>
        </aside>
      )}
    </div>
  )
})
