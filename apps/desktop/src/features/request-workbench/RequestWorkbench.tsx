import type { SettingsCategory } from '../settings-menu/SettingsMenu'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceDto } from '../../bindings/create-workspace'
import type { ExecuteGraphqlRequestOutput } from '../../bindings/execute-graphql-request'
import type { ExecuteRestRequestOutput } from '../../bindings/execute-rest-request'
import { exportHar } from '../../bindings/export-har'
import { pickExportFile } from '../../bindings/pick-export-file'
import { pickResponseFile } from '../../bindings/pick-response-file'
import { saveResponseBody } from '../../bindings/save-response-body'
import { definedVariables } from '../environments/defined-variables'
import { useEnvironmentsState } from '../environments/use-environments-state'
import type { VariableRow } from '../environments/environments.types'
import { rootCollectionOf } from '../collection-runner/runner-plan'
import type { RunStepDto } from '../../bindings/execute-collection-run'
import type { LoadRunDetailDto } from '../../bindings/get-load-run-history'
import { requestIdsForItem } from '../flows/request-chain'
import { useFlowsState } from '../flows/use-flows-state'
import {
  analyzeLoadTestImport,
  commitLoadTestImport,
  type LoadTestImportAnalysisDto,
} from '../../bindings/load-test-import'
import { pickLoadTestFile } from '../../bindings/pick-load-test-file'
import { useValueMonitorsState } from '../value-monitors/use-value-monitors-state'
import { useLanguage } from '../../shared/i18n/use-language'
import { ResizeHandle } from '../../shared/ResizeHandle'
import { useProxy } from '../../shared/proxy/use-proxy'
import { useSchemaAutocomplete } from '../../shared/schema-autocomplete/use-schema-autocomplete'
import { useSecurityPreferences } from '../../shared/security/use-security-preferences'
import { findShortcutAction, isLocalAction, isShortcutEventConsumed, type ShortcutAction } from '../../shared/shortcuts/shortcuts'
import { hasOpenModal } from '../../shared/ui/open-modals'
import { useShortcuts } from '../../shared/shortcuts/use-shortcuts'
import { Tooltip } from '../../shared/ui/Tooltip'
import { useTooltip } from '../../shared/ui/use-tooltip'
import { ChevronLeftIcon, ChevronRightIcon, PanelLeftIcon, ProxyIcon, RunnerIcon } from '../../shared/ui/icons'
import { Button } from '../../shared/ui/Button'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { IconButton } from '../../shared/ui/IconButton'
import { TitleBar } from '../../shared/ui/TitleBar'
import { useToast } from '../../shared/ui/use-toast'
import { useResizablePanel } from '../../shared/use-resizable-panel'
import { AuthorizationPanel } from './components/AuthorizationPanel'
import { ConsolePanel, type ConsolePanelTab } from './components/ConsolePanel'
import { DocsPanel } from './components/DocsPanel'
import { EndpointBar } from './components/EndpointBar'
import { HeadersPanel, type GeneratedHeaderEntry } from './components/HeadersPanel'
import { SessionCookiesModal } from './components/SessionCookiesModal'
import { OpenTabsBar } from './components/OpenTabsBar'
import { WorkspaceLoadErrors } from './components/WorkspaceLoadErrors'
import { ParamsPanel } from './components/ParamsPanel'
import { QueryExplorer } from './components/QueryExplorer'
import { QueryPanel } from './components/QueryPanel'
import { RequestBreadcrumb } from './components/RequestBreadcrumb'
import { ShareMenu } from './components/ShareMenu'
import { ImageImportDropOverlay } from './components/ImageImportDropOverlay'
import { usePseudoTab } from './use-pseudo-tab'
import { useExtensionWorkbenchTabs } from '../../extensions/registry'
import type { PseudoTab } from '../../extensions/types'
import { isPngPath, readImageRequest } from './image-import'
import { readCurlRequest } from './curl-paste-import'
import { Tabs } from '../../shared/ui/Tabs'
import { QueryValidationWarnings } from './components/QueryValidationWarnings'
import { RestBodyPanel } from './components/RestBodyPanel'
import { bodyPreviewText } from './body-state'
import { ScriptsPanel } from './components/ScriptsPanel'
import { captureStatement } from './json-value-index'
import type { JsonPathSegment } from './json-value-index'
import { RestScreen } from './components/RestScreen'
import { GrpcMessagePanel } from './components/GrpcMessagePanel'
import { GrpcMethodPicker } from './components/GrpcMethodPicker'
import { GrpcSchemaPanel } from './components/GrpcSchemaPanel'
import { ResponsePanel } from './components/ResponsePanel'
import type { ResponsePanelLayout } from './components/ResponsePanel'
import { NewRequestPopover } from './components/NewRequestPopover'
import { SaveRequestModal } from './components/SaveRequestModal'
import { SchemaPanel } from './components/SchemaPanel'
import { VariablesPanel } from './components/VariablesPanel'
import { WorkbenchSidebar, type SidebarTab } from './components/WorkbenchSidebar'
import type { CollectionsCommand } from './components/CollectionsPanel'
import type { ConflictResolutionTarget } from '../version-control/ConflictResolver'
import { GitStatusButton } from '../version-control/GitStatusButton'
import { NotificationDetails } from '../notifications/NotificationDetails'
import { NotificationsButton } from '../notifications/NotificationsButton'
import type { AppNotification } from '../notifications/notifications.types'
import { NOTIFICATIONS } from '../notifications/notifications.data'
import { UpdateStatusIndicator } from '../updates/UpdateStatusIndicator'
import { updateNotifications } from '../updates/update-notification'
import { CURRENT_RELEASE_NOTES } from '../updates/release-notes'
import { markReleaseNotesSeen } from '../updates/release-notes-storage'
import { APP_VERSION } from '../../shared/app-version'
import { useUpdates } from '../updates/use-updates'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { useChangedItemMarkers } from '../version-control/use-changed-items'
import { useVersionControl } from '../version-control/use-version-control'
import type { VersionReviewTarget } from '../version-control/VersionControlPanel'
import type { StructuredFileChangesDto } from '../../bindings/gitlab-types'
import { WorkspaceMenu } from '../workspace-menu/WorkspaceMenu'
import { MockServerEditor } from '../mock-servers/MockServerEditor'
import type { MockServerDto } from '../../bindings/mock-servers'
import type { FlowState } from '../flows/flows.types'
import { useCollectionsState, type ImportOutcome } from './use-collections-state'
import { useCollectionFavorites } from './use-collection-favorites'
import { useRequestDocs } from './use-request-docs'
import { jsonBodySchema, parametersIn, schemaTypeLabel } from './schema-docs'
import { parameterNameSuggestions, parameterValueSuggestions } from './schema-completions'
import type { BodySchema } from './schema-completions'
import type { VariableDoc } from './components/VariablePreviewCard'
import { API_DOCS_FILE, VALUE_MONITORS_FILE } from '../version-control/version-summary'
import { buildHar } from './har'
import { harRedactionContext, redactRecordedEntry } from './har-redaction'
import { applyRouteParamValues } from './query-params'
import { resolveTemplateRevealingSecrets } from './resolve-url'
import { defaultGeneratedHeaders } from './generated-headers'
import { cookieHeaderValue, cookiesFor } from './session-cookies'
import { useSessionCookies } from './use-session-cookies'
import { authenticationHeader, overwrittenHeaderName, toAuthenticationInput } from './authorization-state'
import { useConsoleState, type ConsoleEntryInput } from './use-console-state'
import { useRecorderState } from './use-recorder-state'
import type { ActiveComponentKind } from './history'
import { useHistoryState } from './use-history-state'
import { useOpenTabs } from './use-open-tabs'
import type { OpenTabDescriptor } from './use-open-tabs'
import { contentOf, isTabDirty, useWorkbenchState } from './use-workbench-state'
import { useTabSession } from './use-tab-session'
import { findInheritedAuthentication, findNode, findRequest, findRequestPath } from './collection-tree'
import type { RequestContent, RequestSummary } from './collection-tree'
import { graphqlErrorsOf } from './request-workbench.types'
import { formatSize } from './response-summary'
import { responseFileName } from './response-file-name'
import type { RequestTabId, WorkbenchProtocol } from './request-workbench.types'
import { VariableEditingContext } from './variable-editing-context'
import type { VariableEditing } from './variable-editing-context'
import './request-workbench.css'

interface RequestWorkbenchProps {
  workspace: WorkspaceDto
  onWorkspaceChange: (workspace: WorkspaceDto) => void
  onExitToStartScreen: () => void
}

const GRAPHQL_TABS: { id: RequestTabId; label: string }[] = [
  { id: 'docs', label: 'Docs' },
  { id: 'params', label: 'Params' },
  { id: 'query', label: 'Query' },
  { id: 'variables', label: 'Variables' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'headers', label: 'Headers' },
  { id: 'authorization', label: 'Authorization' },
  { id: 'schema', label: 'Schema' },
]

const REST_TABS: { id: RequestTabId; label: string }[] = [
  { id: 'docs', label: 'Docs' },
  { id: 'params', label: 'Params' },
  { id: 'body', label: 'Body' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'headers', label: 'Headers' },
  { id: 'authorization', label: 'Authorization' },
]

/** gRPC requests expose scripts and metadata alongside their message and schema. */
const GRPC_TABS: { id: RequestTabId; label: string }[] = [
  { id: 'message', label: 'Message' },
  { id: 'headers', label: 'Metadata' },
  { id: 'authorization', label: 'Authorization' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'schema', label: 'Schema' },
]

function requestTabsFor(protocol: WorkbenchProtocol): { id: RequestTabId; label: string }[] {
  switch (protocol) {
    case 'rest':
      return REST_TABS
    case 'grpc':
      return GRPC_TABS
    case 'graphql':
      return GRAPHQL_TABS
  }
}

const RESPONSE_LAYOUT_STORAGE_KEY = 'alcy:panel:response-layout'

interface PendingLoadTestImport {
  sourcePath: string
  preview: LoadTestImportAnalysisDto
}

/** Response value monitor preference, shared across all requests. */
const VALUE_MONITOR_STORAGE_KEY = 'alcy:panel:value-monitor'

/** Inline Start mock block (spec 0121); null if removed or no longer inline. */
function inlineMockServerOf(flows: FlowState[], flowId: string, nodeId: string): MockServerDto | null {
  const node = flows.find((flow) => flow.id === flowId)?.nodes.find((candidate) => candidate.id === nodeId)
  return node?.kind === 'mockStart' && node.source.type === 'inline' ? node.source.server : null
}

function loadPersistedValueMonitorEnabled(): boolean {
  try {
    return window.localStorage.getItem(VALUE_MONITOR_STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

function loadPersistedResponseLayout(): ResponsePanelLayout {
  try {
    return window.localStorage.getItem(RESPONSE_LAYOUT_STORAGE_KEY) === 'right' ? 'right' : 'bottom'
  } catch {
    return 'bottom'
  }
}

function useCompactResponseLayout(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 1199px)').matches : false,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 1199px)')
    const update = () => setCompact(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return compact
}

/** Width below which endpoint controls and request tabs would overlap. */
const REQUEST_PANE_MIN_WIDTH = 360
/** Minimum cURL import notice duration. */
const COMMAND_IMPORT_MIN_MS = 350
const RESPONSE_RIGHT_MIN_WIDTH = 280
const RESPONSE_RIGHT_MAX_WIDTH = 900
const SIDEBAR_MAX_SIZE = 440

function useElementWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null)

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return width
}

/** Stable empty environment variables preserve panel memoization. */
const NO_ENVIRONMENT_VARIABLES: VariableRow[] = []

const NON_TEXT_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'file', 'checkbox', 'radio', 'color', 'range'])

/** Allow unmodified shortcuts outside controls, in tabs or in single-line main-area fields. Editors, buttons, lists and modals retain their own behavior. */
function isPlainShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target === document.body) return true
  if (!target.closest('.rw-main')) return false
  if (target.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]')) return false
  if (target.isContentEditable) return false
  if (target.getAttribute('role') === 'tab') return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type)
  return !target.matches('button, a, select, textarea, [role="option"], [role="menuitem"]')
}

// Lazy-load heavy screens and modals to reduce startup parsing and memory use.
const FlowCanvas = lazy(() => import('../flows/FlowCanvas').then((module) => ({ default: module.FlowCanvas })))
const FlowRunSnapshot = lazy(() =>
  import('../flows/FlowRunSnapshot').then((module) => ({ default: module.FlowRunSnapshot })),
)
const LoadRunResults = lazy(() =>
  import('../flows/LoadRunResults').then((module) => ({ default: module.LoadRunResults })),
)
const CollectionRunner = lazy(() =>
  import('../collection-runner/CollectionRunner').then((module) => ({ default: module.CollectionRunner })),
)
const ShareRequestModal = lazy(() =>
  import('./components/ShareRequestModal').then((module) => ({ default: module.ShareRequestModal })),
)
const ShareScreenshotModal = lazy(() =>
  import('./components/ShareScreenshotModal').then((module) => ({ default: module.ShareScreenshotModal })),
)
const ConflictResolver = lazy(() =>
  import('../version-control/ConflictResolver').then((module) => ({ default: module.ConflictResolver })),
)
const ExportWebclientModal = lazy(() =>
  import('../webclient-export/ExportWebclientModal').then((module) => ({ default: module.ExportWebclientModal })),
)
const PullReviewModal = lazy(() =>
  import('../version-control/PullReviewModal').then((module) => ({ default: module.PullReviewModal })),
)
const VersionReview = lazy(() =>
  import('../version-control/VersionReview').then((module) => ({ default: module.VersionReview })),
)

export function RequestWorkbench({ workspace, onWorkspaceChange, onExitToStartScreen }: RequestWorkbenchProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { bindings: shortcutBindings } = useShortcuts()
  // Autosave must notify useVersionControl, declared below. A ref breaks the cycle without changing callback identity or restarting the save debounce.
  const notifyLocalChangeRef = useRef<() => void>(() => {})
  const notifyLocalChange = useCallback(() => notifyLocalChangeRef.current(), [])
  const environments = useEnvironmentsState(workspace.rootPath, notifyLocalChange)
  // Exclude unnamed environment rows still being edited from execution and schema loading.
  const activeEnvironmentRows = environments.activeEnvironment?.variables ?? NO_ENVIRONMENT_VARIABLES
  const activeEnvironmentVariables = useMemo(() => definedVariables(activeEnvironmentRows), [activeEnvironmentRows])
  const collections = useCollectionsState(workspace.rootPath, environments.importEnvironments, notifyLocalChange)
  const collectionFavorites = useCollectionFavorites(workspace.rootPath)
  // Variable preview edits target the defining collection/folder (ADR 0031), or the active environment, creating the variable if needed.
  const { activeEnvironmentId, applyScriptChanges } = environments
  const { applyScopedChanges } = collections
  const variableEditing = useMemo<VariableEditing>(
    () => ({
      canCreate: activeEnvironmentId !== null,
      setValue: (name, value, source) => {
        if (source) applyScopedChanges([{ nodeId: source.nodeId, name, value }])
        else if (activeEnvironmentId !== null) applyScriptChanges([{ name, value }])
      },
    }),
    [activeEnvironmentId, applyScriptChanges, applyScopedChanges],
  )
  const workbench = useWorkbenchState(activeEnvironmentVariables, workspace.rootPath, collections.collections)
  // Collection/folder variables override environment values for highlighting, suggestions, sharing and HAR.
  const effectiveVariables = workbench.effectiveVariables
  const scriptCount = [workbench.preRequestScript, workbench.postResponseScript].filter((script) => script.trim() !== '').length
  const history = useHistoryState(workspace.rootPath)
  const activeRequestId = workbench.activeTab.requestId
  const activeTabId = workbench.activeTab.id
  const sendsSource = useMemo(
    () => ({ rootPath: workspace.rootPath, requestId: activeRequestId, tabId: activeTabId }),
    [workspace.rootPath, activeRequestId, activeTabId],
  )
  const flows = useFlowsState(workspace.rootPath, notifyLocalChange)
  const valueMonitors = useValueMonitorsState(workspace.rootPath, notifyLocalChange, FEATURE_FLAGS.valueMonitors)
  const [valueMonitorEnabled, setValueMonitorEnabled] = useState(loadPersistedValueMonitorEnabled)
  const openTabs = useOpenTabs(workbench, flows)
  const consoleLog = useConsoleState()
  const recorder = useRecorderState()
  const { redactHarSensitiveData } = useSecurityPreferences()
  // Recorder display and export share a list so saved HAR files match visible entries.
  const recorderEntries = useMemo(
    () => (redactHarSensitiveData ? recorder.entries.map(redactRecordedEntry) : recorder.entries),
    [recorder.entries, redactHarSensitiveData],
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('components')
  /** New collection command object per dispatch allows repeating the same shortcut. */
  const [collectionsCommand, setCollectionsCommand] = useState<CollectionsCommand | null>(null)
  const clearCollectionsCommand = useCallback(() => setCollectionsCommand(null), [])
  const versionReviewTab = usePseudoTab<VersionReviewTarget>()
  const conflictTab = usePseudoTab<ConflictResolutionTarget>()
  const { open: openVersionReview, deactivate: deactivateVersionReview } = versionReviewTab
  const { open: openConflict, deactivate: deactivateConflict } = conflictTab
  const extensionTabs = useExtensionWorkbenchTabs()
  // Last inline request saved by a tab, delivered to the mounted flow canvas (FlowCanvas.externalInlineRequest).
  const [savedInlineRequest, setSavedInlineRequest] = useState<
    { flowId: string; nodeId: string; request: RequestSummary; revision: number } | null
  >(null)
  // Last inline mock saved by a tab, following savedInlineRequest.
  const [savedInlineMockServer, setSavedInlineMockServer] = useState<
    { flowId: string; nodeId: string; server: MockServerDto; revision: number } | null
  >(null)
  // Requests dropped onto a flow canvas (spec 0095); the canvas owns viewport placement.
  const [droppedRequestChain, setDroppedRequestChain] = useState<
    { flowId: string; requestIds: string[]; clientPoint: { x: number; y: number }; revision: number } | null
  >(null)
  const [activeLoadRun, setActiveLoadRun] = useState<LoadRunDetailDto | null>(null)
  const [pullReviewOpen, setPullReviewOpen] = useState(false)
  /** Bounds of the plus button opening the request popover, or null when closed. fromSidebar also offers Create Collection. */
  const [newRequestPopover, setNewRequestPopover] = useState<{ anchor: DOMRect; fromSidebar: boolean } | null>(null)
  const openNewRequestPopover = useCallback(
    (anchor: DOMRect) => setNewRequestPopover({ anchor, fromSidebar: false }),
    [],
  )
  const openSidebarNewPopover = useCallback(
    (anchor: DOMRect) => setNewRequestPopover({ anchor, fromSidebar: true }),
    [],
  )
  const closeNewRequestPopover = useCallback(() => setNewRequestPopover(null), [])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleTab, setConsoleTab] = useState<ConsolePanelTab>('console')
  const [harExporting, setHarExporting] = useState(false)
  const harExportingRef = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('general')
  const { reload: reloadCollections } = collections
  const { reload: reloadEnvironments } = environments
  const { reload: reloadFlows } = flows
  const { reload: reloadValueMonitors } = valueMonitors
  // Change after pulls rewrite alcy-api-docs.json to reload documentation.
  const [docsRevision, setDocsRevision] = useState(0)
  // Reload in-memory data after repository updates so autosave does not overwrite updated files.
  const handleWorkspaceFilesChanged = useCallback(
    (names: string[]) => {
      if (names.includes('alcy-collections.json')) reloadCollections()
      if (names.includes('alcy-environments.json')) reloadEnvironments()
      if (names.includes('alcy-flows.json')) reloadFlows()
      if (names.includes(VALUE_MONITORS_FILE)) reloadValueMonitors()
      if (names.includes(API_DOCS_FILE)) setDocsRevision((revision) => revision + 1)
    },
    [reloadCollections, reloadEnvironments, reloadFlows, reloadValueMonitors],
  )
  const versionControl = useVersionControl(workspace.rootPath, handleWorkspaceFilesChanged, FEATURE_FLAGS.gitlab)
  useEffect(() => {
    notifyLocalChangeRef.current = versionControl.notifyLocalChange
  }, [versionControl.notifyLocalChange])
  // Track change markers without requiring the Git sidebar to be opened first.
  const changeMarkers = useChangedItemMarkers(workspace.rootPath, versionControl.files)
  const proxy = useProxy()
  const { phase: updatePhase } = useUpdates()
  const notifications = useMemo(
    () => (FEATURE_FLAGS.updates ? [...NOTIFICATIONS, ...updateNotifications(updatePhase)] : NOTIFICATIONS),
    [updatePhase],
  )
  const proxyModeLabel = proxy.settings.mode === 'pac' ? t('proxy.statusbar.pac') : t('proxy.statusbar.system')
  const proxyTooltip =
    proxy.applyError !== null
      ? t('proxy.statusbar.tooltipError')
      : proxy.settings.mode === 'pac'
        ? t('proxy.statusbar.tooltip.pac')
        : t('proxy.statusbar.tooltip.system')
  const { triggerProps: proxyTooltipProps, tooltip: proxyTooltipElement } = useTooltip(proxyTooltip, { side: 'top' })
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [screenshotModalOpen, setScreenshotModalOpen] = useState(false)
  const [pendingLoadTestImport, setPendingLoadTestImport] = useState<PendingLoadTestImport | null>(null)
  /** Collection/folder being exported as a webclient (spec 0113). */
  const [webclientExportId, setWebclientExportId] = useState<string | null>(null)
  const { webclientSelection } = collections
  const webclientExportSelection = useMemo(
    () => (webclientExportId ? webclientSelection(webclientExportId) : null),
    [webclientExportId, webclientSelection],
  )
  const [queryExplorerCollapsed, setQueryExplorerCollapsed] = useState(false)
  const [responseLayout, setResponseLayout] = useState<ResponsePanelLayout>(loadPersistedResponseLayout)
  const compactResponseLayout = useCompactResponseLayout()
  const effectiveResponseLayout: ResponsePanelLayout = compactResponseLayout ? 'bottom' : responseLayout
  const sidebarPanel = useResizablePanel({
    initialSize: 320,
    minSize: 220,
    maxSize: SIDEBAR_MAX_SIZE,
    axis: 'horizontal',
    storageKey: 'alcy:panel:sidebar',
  })
  const queryExplorerPanel = useResizablePanel({
    initialSize: 300,
    minSize: 220,
    maxSize: 560,
    axis: 'horizontal',
    storageKey: 'alcy:panel:query-explorer',
  })
  const responsePanel = useResizablePanel({
    initialSize: 260,
    minSize: 120,
    maxSize: 720,
    axis: 'vertical',
    direction: 'reverse',
    storageKey: 'alcy:panel:response',
  })
  const [requestResponseLayout, setRequestResponseLayout] = useState<HTMLDivElement | null>(null)
  const requestResponseLayoutWidth = useElementWidth(requestResponseLayout)
  const responsePanelRight = useResizablePanel({
    initialSize: 420,
    minSize: RESPONSE_RIGHT_MIN_WIDTH,
    // Keep the right response panel outside minimum request width, including its 1px resize handle.
    maxSize:
      requestResponseLayoutWidth === null
        ? RESPONSE_RIGHT_MAX_WIDTH
        : Math.max(
            RESPONSE_RIGHT_MIN_WIDTH,
            Math.min(RESPONSE_RIGHT_MAX_WIDTH, requestResponseLayoutWidth - REQUEST_PANE_MIN_WIDTH - 1),
          ),
    axis: 'horizontal',
    direction: 'reverse',
    storageKey: 'alcy:panel:response-right',
  })
  const activeResponsePanel = effectiveResponseLayout === 'right' ? responsePanelRight : responsePanel
  const consolePanel = useResizablePanel({
    initialSize: 320,
    minSize: 140,
    maxSize: 480,
    axis: 'vertical',
    direction: 'reverse',
    storageKey: 'alcy:panel:console',
  })
  const isResizingAny =
    sidebarPanel.isResizing ||
    queryExplorerPanel.isResizing ||
    responsePanel.isResizing ||
    responsePanelRight.isResizing ||
    consolePanel.isResizing
  const resizeCursor = responsePanel.isResizing || consolePanel.isResizing ? 'row-resize' : 'col-resize'
  const onToggleValueMonitor = useCallback(() => {
    setValueMonitorEnabled((current) => {
      try {
        window.localStorage.setItem(VALUE_MONITOR_STORAGE_KEY, current ? 'off' : 'on')
      } catch {
        // Storage unavailable; this choice will not persist across sessions.
      }
      return !current
    })
  }, [])
  const responseMonitor = useMemo(
    () => ({ monitors: valueMonitors.monitors, enabled: valueMonitorEnabled, onToggle: onToggleValueMonitor }),
    [valueMonitors.monitors, valueMonitorEnabled, onToggleValueMonitor],
  )

  const onToggleResponseLayout = useCallback(() => {
    setResponseLayout((current) => {
      const next = current === 'bottom' ? 'right' : 'bottom'
      try {
        window.localStorage.setItem(RESPONSE_LAYOUT_STORAGE_KEY, next)
      } catch {
        // Storage unavailable; this choice will not persist across sessions.
      }
      return next
    })
  }, [])

  useEffect(() => {
    for (const tab of workbench.tabs) {
      if (!tab.requestId) continue
      const found = findRequest(collections.collections, tab.requestId)
      if (!found) {
        workbench.detachRequest(tab.id)
      } else if (found.name !== tab.name) {
        workbench.renameTab(tab.id, found.name)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections.collections])

  // Wait for session restoration before showing the empty screen to avoid flashing on reopen.
  const { restored: tabsRestored } = useTabSession({
    rootPath: workspace.rootPath,
    tabs: workbench.tabs,
    activeTabId: workbench.activeTabId,
    collections: collections.collections,
    collectionsLoaded: collections.loaded,
    contentOf,
    restoreTabs: workbench.restoreTabs,
  })

  const { openRequest, openHistoryEntry, openDraft } = workbench
  const { restore, refresh: refreshHistory, loadFlowRun, loadCollectionRun, loadLoadRun, entries: historyEntries } = history
  const { openRunLog, closeRunLogPreview, openRunner, openNotification, openMockServer, updateMockServerTab } = openTabs
  // Run logs belong to flows for the current-component filter; notifications are not a component.
  const activeOpenTabKind: ActiveComponentKind =
    !openTabs.activeOpenTab || openTabs.activeOpenTab.kind === 'notification' || openTabs.activeOpenTab.kind === 'mockServer'
      ? null
      : openTabs.activeOpenTab.kind === 'request'
        ? 'request'
        : openTabs.activeOpenTab.kind === 'runner'
          ? 'runner'
          : 'flow'

  /** Open notification details above version review or conflict resolution. */
  const handleOpenNotification = useCallback(
    (notification: AppNotification) => {
      deactivateVersionReview()
      deactivateConflict()
      openNotification(notification)
    },
    [deactivateConflict, deactivateVersionReview, openNotification],
  )
  const openReleaseNotes = useMemo(() => {
    const notes = CURRENT_RELEASE_NOTES
    return notes ? () => handleOpenNotification(notes) : undefined
  }, [handleOpenNotification])
  // Open release notes on first launch after restoring tabs so notes appear in front.
  useEffect(() => {
    if (tabsRestored && openReleaseNotes && markReleaseNotesSeen(APP_VERSION)) openReleaseNotes()
  }, [tabsRestored, openReleaseNotes])

  const handleOpenRequest = useCallback(
    (id: string, content: RequestContent, name: string) => {
      closeRunLogPreview()
      openRequest(id, content, name)
    },
    [closeRunLogPreview, openRequest],
  )

  // Shared images become unsaved drafts; other formats create collections.
  const { importCollectionsFromPath } = collections
  const importFromPath = useCallback(
    async (path: string): Promise<ImportOutcome> => {
      if (!isPngPath(path)) return importCollectionsFromPath(path)
      const result = await readImageRequest(path, workspace.rootPath)
      if (!result.ok) return { ok: false, message: result.message ?? t('imageImport.noRequest') }
      closeRunLogPreview()
      openDraft(result.request.name, result.request.content)
      return { ok: true }
    },
    [importCollectionsFromPath, closeRunLogPreview, openDraft, t, workspace.rootPath],
  )

  // Pasted cURL replaces the empty endpoint tab. Keep the notice visible briefly to avoid flashing before the request changes.
  const { replaceTabContent } = workbench
  const [commandImportTabId, setCommandImportTabId] = useState<string | null>(null)
  const [commandImportCount, setCommandImportCount] = useState(0)
  const importCommandIntoActiveTab = useCallback(
    async (command: string) => {
      const tabId = workbench.activeTabId
      if (!tabId || commandImportTabId !== null) return
      setCommandImportTabId(tabId)
      const [result] = await Promise.all([
        readCurlRequest(command, workspace.rootPath),
        new Promise((resolve) => setTimeout(resolve, COMMAND_IMPORT_MIN_MS)),
      ])
      setCommandImportTabId(null)
      if (!result.ok) {
        showToast(t('endpointBar.commandImportError', { message: result.message ?? t('endpointBar.commandNoRequest') }), 'error')
        return
      }
      replaceTabContent(tabId, result.content)
      setCommandImportCount((count) => count + 1)
    },
    [commandImportTabId, replaceTabContent, showToast, t, workbench.activeTabId, workspace.rootPath],
  )

  /** Save response bodies to the chosen file. Large bodies cross IPC by handle while retained in the backend. */
  const downloadResponse = async (value: ExecuteGraphqlRequestOutput | ExecuteRestRequestOutput, requestName: string) => {
    const path = await pickResponseFile(responseFileName(requestName, value.headers, value.bodyEncoding), t('endpointBar.allFiles'))
    if (path === null) return
    const result = await saveResponseBody({
      path,
      encoding: value.bodyEncoding,
      source: value.body.kind === 'inline' ? { kind: 'inline', body: value.body.body } : { kind: 'windowed', handle: value.body.handle },
    })
    if (result.ok) {
      showToast(t('toasts.responseSaved'))
    } else if (result.error.kind === 'notFound') {
      showToast(t('toasts.responseUnavailable'), 'error')
    } else {
      showToast(t('toasts.responseSaveError', { message: result.error.message }), 'error')
    }
  }

  /** gRPC records script effects and history without HTTP cookies or recording. */
  const handleSendGrpc = async () => {
    const endpointUrl = workbench.endpointUrl
    const result = await workbench.sendGrpc()
    const effects = result.ok ? result.value : result
    environments.applyScriptChanges((effects.environmentChanges ?? []).filter((change): change is { name: string; value: string } => change.value !== null))
    collections.applyScopedChanges(effects.scopedChanges ?? [])
    const scriptError = result.ok ? result.value.scriptError?.message : result.error.kind === 'script' ? result.error.message : null
    consoleLog.append({
      kind: 'request',
      endpointUrl,
      executedAtMs: Date.now(),
      durationMs: result.ok ? result.value.durationMs : null,
      outcome: result.ok && result.value.status.code === 0 ? 'success' : 'error',
      statusCode: null,
      hasGraphqlErrors: false,
      errorKind: result.ok ? null : result.error.kind,
      scriptMessage: null,
      detail: null,
    })
    for (const entry of [
      ...(effects.scriptLogs ?? []).map((message) => ({ message, failed: false })),
      ...(scriptError ? [{ message: scriptError, failed: true }] : []),
    ]) {
      consoleLog.append({ kind: 'script', endpointUrl, executedAtMs: Date.now(), durationMs: null,
        outcome: entry.failed ? 'error' : 'success', statusCode: null, hasGraphqlErrors: false,
        errorKind: null, scriptMessage: entry.message, detail: null })
    }
    void history.refresh()
  }

  const handleSend = async (options?: { ignoreResponseSizeLimit?: boolean; download?: boolean }) => {
    if (workbench.protocol === 'grpc') return handleSendGrpc()
    const requestName = workbench.activeTab.name
    const endpointUrl = workbench.endpointUrl
    const routeParams = workbench.routeParams
    const method = workbench.protocol === 'rest' ? workbench.method : 'post'
    const requestBody = workbench.protocol === 'rest' ? bodyPreviewText(workbench.body) : workbench.query
    const { requestId } = workbench.activeTab
    const authentication =
      workbench.authorization.type !== 'inherit'
        ? toAuthenticationInput(workbench.authorization)
        : requestId === null
          ? undefined
          : findInheritedAuthentication(collections.collections, requestId).authentication
    const result = await workbench.send({ ignoreResponseSizeLimit: options?.ignoreResponseSizeLimit })
    // Pre-request script effects apply even when sending fails.
    const scriptEffects = result.ok ? result.value : result
    environments.applyScriptChanges((scriptEffects.environmentChanges ?? []).filter((change): change is { name: string; value: string } => change.value !== null))
    collections.applyScopedChanges(scriptEffects.scopedChanges ?? [])
    const value = result.ok ? result.value : null
    const graphqlErrors = graphqlErrorsOf(value)
    const consoleEntry: ConsoleEntryInput = {
      kind: 'request',
      endpointUrl,
      executedAtMs: Date.now(),
      durationMs: result.ok ? result.value.durationMs : null,
      outcome: result.ok ? 'success' : 'error',
      statusCode: result.ok ? result.value.statusCode : null,
      hasGraphqlErrors: !!graphqlErrors && graphqlErrors.length > 0,
      errorKind: result.ok ? null : result.error.kind,
      scriptMessage: null,
      detail: value && {
        method,
        requestBody,
        durationMs: value.durationMs,
        requestHeaders: value.requestHeaders,
        cookies: value.cookies,
        connection: value.connection,
        finalUrl: value.finalUrl,
        waitingMs: value.waitingMs,
        responseHeaders: value.headers,
        body: value.body,
        bodyEncoding: value.bodyEncoding,
      },
    }
    consoleLog.append(consoleEntry)
    // Append each script log/failure as a console event, outside the HTTP recorder, preserving script order.
    const scriptError = result.ok ? (result.value.scriptError?.message ?? null) : result.error.kind === 'script' ? result.error.message : null
    const scriptEvents = [
      ...(scriptEffects.scriptLogs ?? []).map((message) => ({ message, failed: false })),
      ...(scriptError ? [{ message: scriptError, failed: true }] : []),
    ]
    for (const { message, failed } of scriptEvents) {
      consoleLog.append({
        kind: 'script',
        endpointUrl,
        executedAtMs: Date.now(),
        durationMs: null,
        outcome: failed ? 'error' : 'success',
        statusCode: null,
        hasGraphqlErrors: false,
        errorKind: null,
        scriptMessage: message,
        detail: null,
      })
    }
    const recordedEndpointUrl = applyRouteParamValues(
      resolveTemplateRevealingSecrets(endpointUrl, effectiveVariables),
      routeParams.map(({ name, value: routeValue }) => ({
        name,
        value: resolveTemplateRevealingSecrets(routeValue, effectiveVariables),
      })),
    )
    recorder.append({
      ...consoleEntry,
      endpointUrl: recordedEndpointUrl,
      redaction: harRedactionContext(effectiveVariables, (scriptEffects.environmentChanges ?? []).filter((change): change is { name: string; value: string } => change.value !== null), authentication),
    })
    void history.refresh()
    if (options?.download && result.ok) void downloadResponse(result.value, requestName)
  }

  // Stable resend callback for the memoized response panel, calling the latest handleSend.
  const handleSendRef = useRef(handleSend)
  useEffect(() => {
    handleSendRef.current = handleSend
  })
  const handleResendWithoutLimit = useCallback(() => {
    void handleSendRef.current({ ignoreResponseSizeLimit: true })
  }, [])

  /** Append a post-response script statement saving a response value to an environment variable. */
  // Depend on the script and setter only to preserve response panel memoization while typing.
  const { postResponseScript, setPostResponseScript } = workbench
  const handleCaptureValue = useCallback(
    (path: JsonPathSegment[]) => {
      const separator = postResponseScript === '' || postResponseScript.endsWith('\n') ? '' : '\n'
      setPostResponseScript(`${postResponseScript}${separator}${captureStatement(path)}\n`)
      showToast(t('toasts.captureAdded'))
    },
    [postResponseScript, setPostResponseScript, showToast, t],
  )

  const handleSaveHar = useCallback(async () => {
    if (harExportingRef.current) return
    harExportingRef.current = true
    setHarExporting(true)
    try {
      const path = await pickExportFile(t('devConsole.recorderFileName'), 'har')
      if (path === null) return
      const result = await exportHar(path, buildHar(recorderEntries))
      if (result.ok) {
        showToast(t('toasts.harExported'))
      } else {
        showToast(t('devConsole.harExportError', { message: result.error.message }), 'error')
      }
    } finally {
      harExportingRef.current = false
      setHarExporting(false)
    }
  }, [recorderEntries, showToast, t])

  // Status bar buttons select a console tab, or close the console when already active.
  const openConsoleTab = (tab: ConsolePanelTab) => {
    if (consoleOpen && consoleTab === tab) {
      setConsoleOpen(false)
      return
    }
    setConsoleOpen(true)
    setConsoleTab(tab)
  }

  const handleRestoreHistoryEntry = useCallback(
    async (id: string) => {
      const entry = historyEntries.find((candidate) => candidate.id === id)
      if (entry?.origin === 'flow') {
        const detail = await loadFlowRun(id)
        if (detail) openRunLog({ id: `run:${id}`, label: detail.flowName, detail })
        return
      }
      if (entry?.origin === 'runner') {
        const report = await loadCollectionRun(id)
        if (report) {
          openRunner({
            id: `runner-run:${id}`,
            label: t('runner.tabLabel', { name: report.scopeName }),
            scopeId: null,
            report,
          })
        }
        return
      }
      if (entry?.origin === 'load') {
        if (!FEATURE_FLAGS.loadTesting) return
        const report = await loadLoadRun(id)
        if (report) setActiveLoadRun(report)
        return
      }

      const result = await restore(id)
      if (result.ok) {
        closeRunLogPreview()
        const name = entry?.origin === 'collection' ? entry.endpoint : result.content.endpointUrl
        openHistoryEntry(id, name, result.content, result.execution)
        if (result.truncatedBodyTotalBytes !== null) {
          showToast(t('response.historyBodyTruncated', { size: formatSize(result.truncatedBodyTotalBytes) }))
        }
      }
    },
    [historyEntries, loadFlowRun, loadCollectionRun, loadLoadRun, openRunLog, openRunner, restore, closeRunLogPreview, openHistoryEntry, showToast, t],
  )

  /** Open a collection/folder runner, reusing its tab if present. */
  const handleRunCollection = useCallback(
    (nodeId: string) => {
      const node = findNode(collections.collections, nodeId)
      if (!node) return
      openRunner({ id: `runner:${nodeId}`, label: t('runner.tabLabel', { name: node.name }), scopeId: nodeId, report: null })
    },
    [collections.collections, openRunner, t],
  )

  const { openFlow: openFlowTab } = openTabs
  const { addFlowFromRequests } = flows
  const handleGenerateFlow = useCallback(
    (itemId: string) => {
      const item = requestIdsForItem(collections.collections, itemId)
      if (!item || item.requestIds.length === 0) {
        showToast(t('flows.generate.emptyToast'), 'error')
        return
      }
      openFlowTab(addFlowFromRequests(item.name || t('flows.newFlowName'), item.requestIds))
    },
    [collections.collections, addFlowFromRequests, openFlowTab, showToast, t],
  )

  const handleDropOnFlow = useCallback(
    (itemIds: string[], flowId: string, clientPoint: { x: number; y: number }) => {
      const requestIds = itemIds.flatMap((itemId) => requestIdsForItem(collections.collections, itemId)?.requestIds ?? [])
      if (requestIds.length === 0) {
        showToast(t('flows.generate.emptyToast'), 'error')
        return
      }
      setDroppedRequestChain((current) => ({
        flowId,
        requestIds,
        clientPoint,
        revision: (current?.revision ?? 0) + 1,
      }))
    },
    [collections.collections, showToast, t],
  )

  // Use stable flow methods to preserve sidebar prop identities.
  const { addImportedFlow, removeFlow } = flows
  const handleImportLoadTest = useCallback(() => {
    void (async () => {
      const sourcePath = await pickLoadTestFile()
      if (!sourcePath) return
      const analysis = await analyzeLoadTestImport(sourcePath)
      if (!analysis.ok) {
        const message = analysis.error.kind === 'incompatible'
          ? analysis.error.diagnostics.map((diagnostic) => `L${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`).join('\n')
          : ('message' in analysis.error ? analysis.error.message : t('flows.importLoadTestChanged'))
        showToast(message, 'error')
        return
      }
      const preview = analysis.value
      setPendingLoadTestImport({ sourcePath, preview })
    })()
  }, [showToast, t])

  const confirmLoadTestImport = useCallback(() => {
    const pending = pendingLoadTestImport
    if (!pending) return
    setPendingLoadTestImport(null)
    void (async () => {
      const committed = await commitLoadTestImport(workspace.rootPath, pending.sourcePath, pending.preview.analysisHash)
      if (!committed.ok) {
        const message = committed.error.kind === 'staleAnalysis'
          ? t('flows.importLoadTestChanged')
          : ('message' in committed.error ? committed.error.message : t('flows.importLoadTestFailed'))
        showToast(message, 'error')
        return
      }
      openFlowTab(addImportedFlow(committed.value))
      notifyLocalChange()
    })()
  }, [addImportedFlow, notifyLocalChange, openFlowTab, pendingLoadTestImport, showToast, t, workspace.rootPath])

  const { appendMany: appendConsoleMany } = consoleLog
  // Batch runner channel events into one console update per frame.
  const runnerLogBufferRef = useRef<ConsoleEntryInput[]>([])
  const runnerLogFrameRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (runnerLogFrameRef.current !== null) cancelAnimationFrame(runnerLogFrameRef.current)
    },
    [],
  )
  const logRunnerStep = useCallback(
    (step: RunStepDto) => {
      const executedAtMs = Date.now()
      const buffer = runnerLogBufferRef.current
      buffer.push({
        kind: 'request',
        endpointUrl: step.resolvedUrl,
        executedAtMs,
        durationMs: step.durationMs,
        outcome: step.statusCode === null ? 'error' : 'success',
        statusCode: step.statusCode,
        hasGraphqlErrors: false,
        errorKind: null,
        scriptMessage: null,
        detail: null,
      })
      for (const message of step.logs) {
        buffer.push({
          kind: 'script',
          endpointUrl: step.resolvedUrl,
          executedAtMs,
          durationMs: null,
          outcome: 'success',
          statusCode: null,
          hasGraphqlErrors: false,
          errorKind: null,
          scriptMessage: message,
          detail: null,
        })
      }
      if (runnerLogFrameRef.current === null) {
        runnerLogFrameRef.current = requestAnimationFrame(() => {
          runnerLogFrameRef.current = null
          const batch = runnerLogBufferRef.current
          runnerLogBufferRef.current = []
          appendConsoleMany(batch)
        })
      }
    },
    [appendConsoleMany],
  )

  // Inline flow requests (spec 0086) save to their node; removed nodes leave a normal draft.
  const saveFlowNodeTab = (tabId: string, flowId: string, nodeId: string) => {
    const node = flows.flows.find((flow) => flow.id === flowId)?.nodes.find((candidate) => candidate.id === nodeId)
    if (!node || node.kind !== 'inlineRequest') {
      workbench.detachRequest(tabId)
      showToast(t('toasts.inlineRequestMissing'), 'error')
      return
    }
    const content = workbench.contentOfTab(tabId)
    const tab = workbench.tabs.find((candidate) => candidate.id === tabId)
    const request: RequestSummary = { ...node.request, name: tab?.name || node.request.name, protocol: content.protocol, content }
    flows.updateInlineRequest(flowId, nodeId, request)
    setSavedInlineRequest((current) => ({ flowId, nodeId, request, revision: (current?.revision ?? 0) + 1 }))
    workbench.markContentSaved(tabId)
    showToast(t('toasts.inlineRequestSaved'))
  }

  // Inline mock blocks (spec 0121) save to their node, not the mock server file. Return false if removed.
  const saveInlineMockServer = (flowId: string, nodeId: string, server: MockServerDto): boolean => {
    if (!flows.updateInlineMockServer(flowId, nodeId, server)) {
      showToast(t('toasts.inlineMockMissing'), 'error')
      return false
    }
    setSavedInlineMockServer((current) => ({ flowId, nodeId, server, revision: (current?.revision ?? 0) + 1 }))
    showToast(t('toasts.inlineMockSaved'))
    return true
  }

  const handleSaveTab = (tabId: string) => {
    const tab = workbench.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || !isTabDirty(tab)) return
    if (tab.flowNodeRef) {
      saveFlowNodeTab(tabId, tab.flowNodeRef.flowId, tab.flowNodeRef.nodeId)
    } else if (tab.requestId) {
      collections.updateRequestContent(tab.requestId, workbench.contentOfTab(tabId))
      workbench.markContentSaved(tabId)
      showToast(t('toasts.requestSaved'))
    } else {
      workbench.selectTab(tabId)
      setSaveModalOpen(true)
    }
  }

  const handleSave = () => {
    if (workbench.activeTabId) handleSaveTab(workbench.activeTabId)
  }

  const handleSaveAs = (parentId: string, name: string) => {
    if (!workbench.activeTabId) return
    const { id, name: finalName } = collections.addRequest(
      parentId,
      name,
      workbench.activeTab.protocol,
      workbench.contentOfTab(workbench.activeTabId),
    )
    workbench.markSaved(workbench.activeTabId, id, finalName)
    setSaveModalOpen(false)
    showToast(t('toasts.requestSaved'))
  }

  const onToggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((current) => !current), [])

  // Stable sidebar props prevent rerendering the sidebar and collection tree on each keystroke.
  const sidebarVersionControl = useMemo(
    () => ({
      rootPath: workspace.rootPath,
      vc: versionControl,
      onOpenSettings: () => {
        setSettingsCategory('gitlab')
        setSettingsOpen(true)
      },
      onReview: (target: VersionReviewTarget) => {
        deactivateConflict()
        openVersionReview(target)
      },
      onPull: () => setPullReviewOpen(true),
      onResolveConflict: (fileName: string, changes: StructuredFileChangesDto) => {
        deactivateVersionReview()
        openConflict({ fileName, changes })
      },
    }),
    [workspace.rootPath, versionControl, deactivateConflict, openVersionReview, deactivateVersionReview, openConflict],
  )
  const openGeneralSettings = useCallback(() => {
    setSettingsCategory('general')
    setSettingsOpen(true)
  }, [])
  const onSettingsOpenChange = useCallback(
    (open: boolean) => {
      if (open) setSettingsCategory('general')
      // Sensitive-value protection changes environment comparisons; recheck local changes on close.
      else notifyLocalChange()
      setSettingsOpen(open)
    },
    [notifyLocalChange],
  )

  const environmentsSlice = useMemo(
    () => ({
      environments: environments.environments,
      unreadableSecrets: environments.unreadableSecrets,
      activeEnvironmentId: environments.activeEnvironmentId,
      onSelectEnvironment: environments.setActiveEnvironmentId,
      onAddEnvironment: environments.addEnvironment,
      onRemoveEnvironment: environments.removeEnvironment,
      onDuplicateEnvironment: environments.duplicateEnvironment,
      onRenameEnvironment: environments.renameEnvironment,
      onMoveEnvironment: environments.moveEnvironment,
      onAddVariable: environments.addVariable,
      onUpdateVariable: environments.updateVariable,
      onRemoveVariable: environments.removeVariable,
      onMoveVariable: environments.moveVariable,
      onReplaceVariables: environments.replaceVariables,
    }),
    [
      environments.environments,
      environments.unreadableSecrets,
      environments.activeEnvironmentId,
      environments.setActiveEnvironmentId,
      environments.addEnvironment,
      environments.removeEnvironment,
      environments.duplicateEnvironment,
      environments.renameEnvironment,
      environments.moveEnvironment,
      environments.addVariable,
      environments.updateVariable,
      environments.removeVariable,
      environments.moveVariable,
      environments.replaceVariables,
    ],
  )

  // Imported docs for the active request (ADR 0035): Docs tab and suggestions.
  const activeDocsRef = useMemo(
    () =>
      workbench.activeTab.requestId === null
        ? null
        : (findRequest(collections.collections, workbench.activeTab.requestId)?.docsRef ?? null),
    [collections.collections, workbench.activeTab.requestId],
  )
  const requestDocs = useRequestDocs(workspace.rootPath, activeDocsRef, docsRevision)
  const { enabled: schemaAutocompleteEnabled } = useSchemaAutocomplete()
  const suggestionDocs = schemaAutocompleteEnabled && requestDocs.status === 'ready' ? requestDocs.docs : null
  const queryParameterDocs = useMemo(() => (suggestionDocs ? parametersIn(suggestionDocs, 'query') : []), [suggestionDocs])
  const headerParameterDocs = useMemo(() => (suggestionDocs ? parametersIn(suggestionDocs, 'header') : []), [suggestionDocs])
  const paramNameSuggestions = useMemo(
    () =>
      queryParameterDocs.length > 0
        ? parameterNameSuggestions(queryParameterDocs, workbench.params.map((param) => param.name))
        : undefined,
    [queryParameterDocs, workbench.params],
  )
  const paramValueSuggestionsFor = useCallback(
    (name: string) => parameterValueSuggestions(queryParameterDocs, name, suggestionDocs?.schemas ?? {}),
    [queryParameterDocs, suggestionDocs],
  )
  const headerNameSuggestions = useMemo(
    () =>
      headerParameterDocs.length > 0
        ? parameterNameSuggestions(headerParameterDocs, workbench.headers.map((header) => header.name), true)
        : undefined,
    [headerParameterDocs, workbench.headers],
  )
  const headerValueSuggestionsFor = useCallback(
    (name: string) => parameterValueSuggestions(headerParameterDocs, name, suggestionDocs?.schemas ?? {}, true),
    [headerParameterDocs, suggestionDocs],
  )
  const bodySchema = useMemo((): BodySchema | null => {
    const root = suggestionDocs ? jsonBodySchema(suggestionDocs) : null
    return suggestionDocs && root ? { root, schemas: suggestionDocs.schemas } : null
  }, [suggestionDocs])
  // Informational content remains visible with suggestions disabled.
  const pathParameterDocs = useMemo(() => {
    if (requestDocs.status !== 'ready') return undefined
    const docs: Record<string, VariableDoc> = {}
    for (const parameter of parametersIn(requestDocs.docs, 'path')) {
      docs[parameter.name] = {
        type: parameter.schema ? schemaTypeLabel(parameter.schema) : null,
        required: parameter.required,
        description: parameter.description,
      }
    }
    return docs
  }, [requestDocs])

  const inheritedAuthentication = useMemo(
    () =>
      workbench.activeTab.requestId === null
        ? undefined
        : findInheritedAuthentication(collections.collections, workbench.activeTab.requestId),
    [collections.collections, workbench.activeTab.requestId],
  )

  const effectiveAuthentication = useMemo(
    () =>
      workbench.authorization.type === 'inherit'
        ? inheritedAuthentication?.authentication
        : toAuthenticationInput(workbench.authorization),
    [inheritedAuthentication, workbench.authorization],
  )
  // Completed sends may receive Set-Cookie; reload the jar on status change.
  const sessionCookies = useSessionCookies(workbench.execution.status)
  const [sessionCookiesModalOpen, setSessionCookiesModalOpen] = useState(false)
  const generatedHeaders = useMemo(() => {
    const header = authenticationHeader(effectiveAuthentication)
    const authorization: GeneratedHeaderEntry[] = header
      ? [header]
      : effectiveAuthentication?.type === 'digest'
        ? [{ name: 'Authorization', value: t('headers.generatedOnSendValue') }]
        : []
    const resolvedUrl = resolveTemplateRevealingSecrets(workbench.endpointUrl, effectiveVariables)
    const userDefinesCookie = workbench.headers.some(
      (entry) => entry.enabled && entry.name.trim().toLowerCase() === 'cookie',
    )
    const matchingCookies = userDefinesCookie ? [] : cookiesFor(sessionCookies.cookies, resolvedUrl)
    const cookie: GeneratedHeaderEntry[] =
      matchingCookies.length > 0
        ? [{ name: 'Cookie', value: cookieHeaderValue(matchingCookies), reason: t('headers.generatedCookieTooltip') }]
        : []
    // gRPC sends the authentication as metadata; cookies are HTTP only.
    if (workbench.protocol === 'grpc') return header ? [header] : []
    if (workbench.protocol !== 'rest') return [...cookie, ...authorization]
    return [
      ...defaultGeneratedHeaders({
        endpointUrl: resolvedUrl,
        method: workbench.method,
        body: workbench.body,
        headers: workbench.headers,
        onSendValue: t('headers.generatedOnSendValue'),
        reason: t('headers.generatedDefaultTooltip'),
      }),
      ...cookie,
      ...authorization,
    ]
  }, [
    effectiveAuthentication,
    t,
    workbench.protocol,
    workbench.endpointUrl,
    workbench.method,
    workbench.body,
    workbench.headers,
    effectiveVariables,
    sessionCookies.cookies,
  ])
  const headersOverwrittenByAuthorization = useMemo(() => {
    const name = overwrittenHeaderName(effectiveAuthentication)
    return name ? [name] : []
  }, [effectiveAuthentication])

  const collectionsSlice = useMemo(
    () => ({
      collections: collections.collections,
      expandedIds: collections.expandedIds,
      openRequestId: workbench.activeTab.requestId,
      onToggleExpanded: collections.toggleExpanded,
      onCollapseAll: collections.collapseAll,
      onExpandAll: collections.expandAll,
      onRevealRequest: collections.revealRequest,
      onAddCollection: collections.addCollection,
      onAddFolder: collections.addFolder,
      onAddRequest: collections.addRequest,
      onCreateStandaloneRequest: openSidebarNewPopover,
      onOpenRequest: handleOpenRequest,
      onPinRequest: workbench.pinRequest,
      onRename: collections.rename,
      onUpdateAuthentication: collections.updateAuthentication,
      onUpdateVariables: collections.updateVariables,
      favoriteIds: collectionFavorites.favoriteIds,
      onSetFavorites: collectionFavorites.setFavorites,
      onAssignLabel: collections.assignLabel,
      onRenameLabel: collections.renameLabel,
      onRecolorLabel: collections.recolorLabel,
      onRemoveLabel: collections.removeLabel,
      onRemove: collections.remove,
      onRemoveMany: collections.removeMany,
      onMoveMany: collections.moveMany,
      onDuplicateRequest: collections.duplicateRequest,
      onMoveRequest: collections.moveRequest,
      onReorderRequest: collections.reorderRequest,
      onMoveFolder: collections.moveFolder,
      onReorderFolder: collections.reorderFolder,
      onReorderCollections: collections.reorderCollections,
      onSortChildren: collections.sortChildren,
      onExportCollection: collections.exportCollection,
      onExportCollections: collections.exportCollectionsByIds,
      onRunCollection: handleRunCollection,
      onGenerateFlow: handleGenerateFlow,
      onExportWebclient: setWebclientExportId,
      onDropOnFlow: handleDropOnFlow,
      onExportAll: collections.exportAll,
      onPrepareImportFromPath: collections.prepareCollectionsFromPath,
      onPrepareImportFromUrl: collections.prepareCollectionsFromUrl,
      onPrepareImportFromText: collections.prepareCollectionsFromText,
      onCommitPreparedImport: collections.commitPreparedCollection,
      environmentVariables: activeEnvironmentVariables,
      command: collectionsCommand,
      onCommandHandled: clearCollectionsCommand,
    }),
    [
      collections.collections,
      collections.expandedIds,
      workbench.activeTab.requestId,
      collections.toggleExpanded,
      collections.collapseAll,
      collections.expandAll,
      collections.revealRequest,
      collections.addCollection,
      collections.addFolder,
      collections.addRequest,
      openSidebarNewPopover,
      handleOpenRequest,
      workbench.pinRequest,
      collections.rename,
      collections.updateAuthentication,
      collections.updateVariables,
      collectionFavorites.favoriteIds,
      collectionFavorites.setFavorites,
      collections.assignLabel,
      collections.renameLabel,
      collections.recolorLabel,
      collections.removeLabel,
      collections.remove,
      collections.removeMany,
      collections.moveMany,
      collections.duplicateRequest,
      collections.moveRequest,
      collections.reorderRequest,
      collections.moveFolder,
      collections.reorderFolder,
      collections.reorderCollections,
      collections.sortChildren,
      collections.exportCollection,
      collections.exportCollectionsByIds,
      handleRunCollection,
      handleGenerateFlow,
      setWebclientExportId,
      handleDropOnFlow,
      collections.exportAll,
      collections.prepareCollectionsFromPath,
      collections.prepareCollectionsFromUrl,
      collections.prepareCollectionsFromText,
      collections.commitPreparedCollection,
      activeEnvironmentVariables,
      collectionsCommand,
      clearCollectionsCommand,
    ],
  )

  const historySlice = useMemo(
    () => ({
      entries: history.entries,
      loaded: history.loaded,
      activeComponentKind: activeOpenTabKind,
      onRestore: handleRestoreHistoryEntry,
      onRefresh: refreshHistory,
    }),
    [history.entries, history.loaded, activeOpenTabKind, handleRestoreHistoryEntry, refreshHistory],
  )

  const { openFlow, closeOpenTab } = openTabs
  const { openFlowNodeRequest } = workbench
  const openInlineRequest = useCallback(
    (flowId: string, nodeId: string, request: RequestSummary) => {
      closeRunLogPreview()
      openFlowNodeRequest({ flowId, nodeId }, request.name, request.content)
    },
    [closeRunLogPreview, openFlowNodeRequest],
  )
  const reviewedItem = versionReviewTab.target?.item
  const openReviewedItem = useCallback(() => {
    const item = reviewedItem
    if (!item) return
    const id = item.id.slice(item.id.indexOf(':') + 1)
    if (item.itemKind === 'request') {
      const request = findRequest(collections.collections, id)
      if (request) handleOpenRequest(request.id, request.content, request.name)
    } else if (item.itemKind === 'flow' && flows.flows.some((flow) => flow.id === id)) {
      openFlow(id)
    } else {
      return
    }
    deactivateVersionReview()
  }, [collections.collections, flows.flows, handleOpenRequest, openFlow, reviewedItem, deactivateVersionReview])

  /** Close deleted flow tabs to avoid dangling tabs falling through to the request screen. */
  const handleRemoveFlow = useCallback(
    (id: string) => {
      removeFlow(id)
      closeOpenTab(id)
    },
    [removeFlow, closeOpenTab],
  )

  const valueMonitorsSlice = useMemo(
    () => ({
      monitors: valueMonitors.monitors,
      error: valueMonitors.error,
      onAddMonitor: valueMonitors.addMonitor,
      onRemoveMonitor: valueMonitors.removeMonitor,
      onRenameMonitor: valueMonitors.renameMonitor,
      onSetMonitorEnabled: valueMonitors.setMonitorEnabled,
      onAddField: valueMonitors.addField,
      onRemoveField: valueMonitors.removeField,
      onAddRule: valueMonitors.addRule,
      onUpdateRule: valueMonitors.updateRule,
      onRemoveRule: valueMonitors.removeRule,
    }),
    [
      valueMonitors.monitors,
      valueMonitors.error,
      valueMonitors.addMonitor,
      valueMonitors.removeMonitor,
      valueMonitors.renameMonitor,
      valueMonitors.setMonitorEnabled,
      valueMonitors.addField,
      valueMonitors.removeField,
      valueMonitors.addRule,
      valueMonitors.updateRule,
      valueMonitors.removeRule,
    ],
  )

  const flowsSlice = useMemo(
    () => ({
      flows: FEATURE_FLAGS.loadTesting ? flows.flows : flows.flows.filter((flow) => flow.executionKind !== 'load'),
      onAddFlow: flows.addFlow,
      onAddLoadFlow: FEATURE_FLAGS.loadTesting ? flows.addLoadFlow : undefined,
      onImportLoadTest: FEATURE_FLAGS.loadTesting ? handleImportLoadTest : undefined,
      onRenameFlow: flows.renameFlow,
      onRemoveFlow: handleRemoveFlow,
      onMoveFlow: flows.moveFlow,
      onOpenFlow: openFlow,
    }),
    [flows.flows, flows.addFlow, flows.addLoadFlow, flows.renameFlow, flows.moveFlow, handleImportLoadTest, handleRemoveFlow, openFlow],
  )

  const activeFlow =
    openTabs.activeOpenTab?.kind === 'flow'
      ? flows.flows.find((flow) => flow.id === openTabs.activeOpenTab?.id && (FEATURE_FLAGS.loadTesting || flow.executionKind !== 'load'))
      : undefined

  const activeRunLog =
    openTabs.activeOpenTab?.kind === 'runLog'
      ? openTabs.runLogTabs.find((tab) => tab.id === openTabs.activeOpenTab?.id)
      : undefined

  const activeNotificationTab =
    openTabs.activeOpenTab?.kind === 'notification'
      ? openTabs.notificationTabs.find((tab) => tab.id === openTabs.activeOpenTab?.id)
      : undefined

  const activeMockServerTab =
    openTabs.activeOpenTab?.kind === 'mockServer'
      ? openTabs.mockServerTabs.find((tab) => tab.id === openTabs.activeOpenTab?.id)
      : undefined
  const activeMockServerId = activeMockServerTab?.serverId ?? null

  const mockServersSlice = useMemo(
    () => ({ rootPath: workspace.rootPath, activeServerId: activeMockServerId, onOpenServer: openMockServer }),
    [activeMockServerId, openMockServer, workspace.rootPath],
  )

  const activeRequestCollection = useMemo(
    () =>
      workbench.activeTab.requestId ? rootCollectionOf(collections.collections, workbench.activeTab.requestId) : null,
    [collections.collections, workbench.activeTab.requestId],
  )

  const requestBreadcrumbSegments = useMemo(() => {
    const { requestId, flowNodeRef } = workbench.activeTab
    if (flowNodeRef) {
      const flow = flows.flows.find((candidate) => candidate.id === flowNodeRef.flowId)
      return [flow?.name || t('common.unnamed'), workbench.activeTab.name || t('workbench.openTabs.untitled')]
    }
    if (requestId) {
      const path = findRequestPath(collections.collections, requestId)
      if (path) return path
    }
    return [workbench.activeTab.name || t('workbench.openTabs.untitled')]
  }, [collections.collections, flows.flows, workbench.activeTab, t])

  // Bar order: version review, conflict, then the extensions' tabs. When
  // several are active, the last one wins (an extension's tab shows over a
  // version tab).
  const pseudoTabs: PseudoTab[] = [
    ...(versionReviewTab.target
      ? [{
          id: 'version-review',
          label: versionReviewTab.target.item?.label ?? versionReviewTab.target.fileLabel,
          dirty: false,
          preview: true,
          active: versionReviewTab.active,
          activate: versionReviewTab.activate,
          deactivate: versionReviewTab.deactivate,
          close: versionReviewTab.close,
          content: (
            <VersionReview
              rootPath={workspace.rootPath}
              target={versionReviewTab.target}
              onOpenItem={['request', 'flow'].includes(versionReviewTab.target.item?.itemKind ?? '') ? openReviewedItem : undefined}
            />
          ),
        }]
      : []),
    ...(conflictTab.target
      ? [{
          id: 'conflict-resolution',
          label: t('vc.resolve.title'),
          dirty: false,
          preview: true,
          active: conflictTab.active,
          activate: conflictTab.activate,
          deactivate: conflictTab.deactivate,
          close: conflictTab.close,
          content: <ConflictResolver rootPath={workspace.rootPath} vc={versionControl} target={conflictTab.target} onResolved={conflictTab.close} />,
        }]
      : []),
    ...extensionTabs,
  ]
  const activePseudoTab = pseudoTabs.findLast((tab) => tab.active)
  const pseudoTabById = (id: string) => pseudoTabs.find((tab) => tab.id === id)

  // Extension tabs step back when the open request/flow tab changes or a
  // version tab comes to the front; they stay open in the bar.
  const extensionTabsRef = useRef(extensionTabs)
  useEffect(() => {
    extensionTabsRef.current = extensionTabs
  })
  const activeOpenTabId = openTabs.activeOpenTab?.id ?? null
  const versionTabActive = versionReviewTab.active || conflictTab.active
  useEffect(() => {
    for (const tab of extensionTabsRef.current) tab.deactivate()
  }, [activeOpenTabId])
  useEffect(() => {
    if (versionTabActive) for (const tab of extensionTabsRef.current) tab.deactivate()
  }, [versionTabActive])

  const barTabs: OpenTabDescriptor[] = [
    ...openTabs.descriptors,
    ...pseudoTabs.map((tab) => ({ id: tab.id, kind: 'runLog' as const, label: tab.label, dirty: tab.dirty, preview: tab.preview ?? false, fixed: false, fixable: false })),
  ]
  const barActiveTabId = activePseudoTab?.id ?? openTabs.activeOpenTab?.id ?? null

  const selectBarTab = (id: string) => {
    const selected = pseudoTabById(id)
    for (const tab of pseudoTabs) if (tab !== selected) tab.deactivate()
    if (selected) selected.activate()
    else openTabs.selectOpenTab(id)
  }

  // Cycle through adjacent tabs (1 = right, -1 = left).
  const cycleBarTab = (step: number) => {
    const currentIndex = barTabs.findIndex((tab) => tab.id === barActiveTabId)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + step + barTabs.length) % barTabs.length
    selectBarTab(barTabs[nextIndex].id)
  }

  const requestTabActive =
    openTabs.activeOpenTab?.kind === 'request' && barActiveTabId === openTabs.activeOpenTab.id
  const shortcutAvailable = (action: ShortcutAction): boolean => {
    switch (action) {
      case 'sendRequest':
        return requestTabActive && workbench.execution.status !== 'loading'
      case 'saveRequest':
        return openTabs.activeOpenTab?.kind === 'request' && !activePseudoTab?.capturesInput
      case 'nextTab':
      case 'previousTab':
        return barTabs.length >= 2
      case 'newRequest':
      case 'newCollection':
      case 'importCollections':
      case 'searchCollections':
      case 'toggleSidebar':
      case 'openSettings':
        // Panel actions must not run behind a modal.
        return !hasOpenModal()
      case 'closeTab':
      case 'openBlockPalette':
      case 'renameItem':
      case 'duplicateItem':
      case 'deleteItem':
      case 'acceptSuggestion':
      case 'toggleSuggestions':
        // Local actions are dispatched by tabs, canvas, sidebar rows and editors (isLocalAction).
        return false
    }
  }
  /** Show collections, expand the sidebar and forward the command. */
  const runCollectionsCommand = (command: CollectionsCommand) => {
    setSidebarTab('components')
    if (sidebarCollapsed) setSidebarCollapsed(false)
    setCollectionsCommand(command)
  }
  /** Anchor the new request popover to the tab bar plus button. */
  const openNewRequestFromShortcut = () => {
    const button = document.querySelector<HTMLElement>('.rw-open-tab-new')
    const main = document.querySelector<HTMLElement>('.rw-main')?.getBoundingClientRect()
    openNewRequestPopover(button?.getBoundingClientRect() ?? new DOMRect(main ? main.left + main.width / 2 : 0, main?.top ?? 0, 0, 0))
  }
  const runShortcut = (action: ShortcutAction) => {
    switch (action) {
      case 'sendRequest':
        void handleSend()
        return
      case 'saveRequest':
        handleSave()
        return
      case 'newRequest':
        openNewRequestFromShortcut()
        return
      case 'nextTab':
        cycleBarTab(1)
        return
      case 'previousTab':
        cycleBarTab(-1)
        return
      case 'newCollection':
        runCollectionsCommand({ kind: 'rename', id: collections.addCollection() })
        return
      case 'importCollections':
        runCollectionsCommand({ kind: 'import' })
        return
      case 'searchCollections':
        runCollectionsCommand({ kind: 'search' })
        return
      case 'toggleSidebar':
        onToggleSidebarCollapsed()
        return
      case 'openSettings':
        setSettingsCategory('general')
        setSettingsOpen(true)
        return
      case 'closeTab':
      case 'openBlockPalette':
      case 'renameItem':
      case 'duplicateItem':
      case 'deleteItem':
      case 'acceptSuggestion':
      case 'toggleSuggestions':
        return
    }
  }

  // Always consume Ctrl/Alt shortcuts. Unmodified shortcuts require an available action and focus outside controls already using the key.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShortcutEventConsumed(event) || event.isComposing) return
      const action = findShortcutAction(shortcutBindings, event)
      // Local actions are dispatched by their component (canvas, sidebar).
      if (!action || isLocalAction(action)) return
      const plain = !(event.ctrlKey || event.metaKey || event.altKey)
      if (plain && !isPlainShortcutTarget(event.target)) return
      const available = shortcutAvailable(action)
      if (plain && !available) return
      event.preventDefault()
      if (available) runShortcut(action)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <VariableEditingContext value={variableEditing}>
      {pendingLoadTestImport && (
        <ConfirmDialog
          title={t('flows.importLoadTestAria')}
          description={t('flows.importLoadTestConfirm', {
            format: pendingLoadTestImport.preview.format,
            blocks: pendingLoadTestImport.preview.blocks,
            destinations: pendingLoadTestImport.preview.destinations.length > 0
              ? pendingLoadTestImport.preview.destinations.join(', ')
              : t('flows.importLoadTestNoDestination'),
            assets: pendingLoadTestImport.preview.assets.join(', ') || t('common.empty'),
          })}
          confirmLabel={t('flows.importLoadTestConfirmButton')}
          cancelLabel={t('common.cancel')}
          closeAriaLabel={t('common.cancel')}
          onConfirm={confirmLoadTestImport}
          onCancel={() => setPendingLoadTestImport(null)}
          tone="primary"
        />
      )}
      <div className="rw-shell">
        <TitleBar>
          <WorkspaceMenu
            currentWorkspace={workspace}
            remoteLinked={versionControl.linkLoaded ? versionControl.link !== null : null}
            onWorkspaceChange={onWorkspaceChange}
            onExitToStartScreen={onExitToStartScreen}
            onLocalChange={notifyLocalChange}
          />
          <h1 className="app-titlebar-brand">Alcy</h1>
          <div className="rw-header-actions">
            <IconButton
              icon={<PanelLeftIcon size={14} />}
              label={sidebarCollapsed ? t('workbench.sidebarToggle.showAria') : t('workbench.sidebarToggle.hideAria')}
              onClick={onToggleSidebarCollapsed}
            />
          </div>
        </TitleBar>

        <div className="rw-body">
          <div className="rw-sidebar-wrapper" style={{ width: sidebarCollapsed ? 'var(--workbench-rail-width)' : `calc(${sidebarPanel.size}px + var(--workbench-rail-width))` }}>
            <WorkbenchSidebar
              collapsed={sidebarCollapsed}
              onToggleCollapsed={onToggleSidebarCollapsed}
              environments={environmentsSlice}
              collections={collectionsSlice}
              history={historySlice}
              flows={flowsSlice}
              valueMonitors={valueMonitorsSlice}
              mockServers={mockServersSlice}
              changeMarkers={changeMarkers}
              settingsOpen={settingsOpen}
              settingsCategory={settingsCategory}
              activeTab={sidebarTab}
              onActiveTabChange={setSidebarTab}
              versionControl={sidebarVersionControl}
              onOpenReleaseNotes={openReleaseNotes}
              onSettingsOpenChange={onSettingsOpenChange}
            />
          </div>
          {!sidebarCollapsed && (
            <ResizeHandle
              ariaLabel={t('workbench.resize.sidebar')}
              orientation="vertical"
              onPointerDown={sidebarPanel.startResizing}
            />
          )}

          <main className="rw-main">
            <WorkspaceLoadErrors
              areas={[
                { area: 'collections', message: collections.loadError, retry: collections.reload },
                { area: 'environments', message: environments.loadError, retry: environments.reload },
                { area: 'flows', message: flows.loadError, retry: flows.reload },
                { area: 'valueMonitors', message: valueMonitors.loadError, retry: valueMonitors.reload },
              ]}
            />
            <OpenTabsBar
              tabs={barTabs}
              activeTabId={barActiveTabId}
              onSelect={selectBarTab}
              onPin={(id) => { if (!pseudoTabById(id)) openTabs.pinOpenTab(id) }}
              onClose={(id) => {
                // The tab bar already confirmed discarding unsaved changes.
                const pseudoTab = pseudoTabById(id)
                if (pseudoTab) pseudoTab.close()
                else openTabs.closeOpenTab(id)
              }}
              onCloseAll={() => {
                for (const tab of pseudoTabs) tab.close()
                openTabs.closeAllOpenTabs()
              }}
              onCloseOthers={(id) => {
                for (const tab of pseudoTabs) if (tab.id !== id) tab.close()
                if (pseudoTabById(id)) openTabs.closeAllOpenTabs()
                else openTabs.closeOtherOpenTabs(id)
              }}
              onCloseUnfixed={() => {
                for (const tab of pseudoTabs) tab.close()
                openTabs.closeUnfixedOpenTabs()
              }}
              onCloseMany={(ids) => {
                for (const tab of pseudoTabs) if (ids.includes(tab.id)) tab.close()
                openTabs.closeOpenTabs(ids)
              }}
              onToggleFix={openTabs.toggleFixOpenTab}
              onNewTab={openNewRequestPopover}
              onReorder={openTabs.reorderOpenTabs}
              onReorderGroup={openTabs.reorderOpenTabsGroup}
              onSaveTab={handleSaveTab}
              environments={environments.environments}
              activeEnvironmentId={environments.activeEnvironmentId}
              onEnvironmentChange={environments.setActiveEnvironmentId}
            />

            {/* No loading indicator: the chunk arrives quickly and a spinner would blur the canvas in WebKitGTK. */}
            <Suspense fallback={null}>
            {activePseudoTab ? (
              activePseudoTab.content
            ) : !tabsRestored ? (
              <div className="rw-rest-screen" aria-busy="true" />
            ) : openTabs.descriptors.length === 0 ? (
              <RestScreen
                onAddGraphqlRequest={() => workbench.newDraftTab('graphql', t('collections.newRequestName'))}
                onAddRestRequest={() => workbench.newDraftTab('rest', t('collections.newRequestName'))}
                onAddGrpcRequest={() => workbench.newDraftTab('grpc', t('collections.newRequestName'))}
              />
            ) : openTabs.activeOpenTab?.kind === 'runner' || activeMockServerTab ? null : activeNotificationTab ? (
              <NotificationDetails key={activeNotificationTab.id} notification={activeNotificationTab.notification} />
            ) : activeLoadRun && FEATURE_FLAGS.loadTesting ? (
              <LoadRunResults
                key={`${workspace.rootPath}:${activeLoadRun.id}`}
                rootPath={workspace.rootPath}
                detail={activeLoadRun}
                onClose={() => setActiveLoadRun(null)}
              />
            ) : activeRunLog ? (
              <FlowRunSnapshot
                key={activeRunLog.id}
                detail={activeRunLog.detail}
                collections={collections.collections}
                environmentVariables={activeEnvironmentVariables}
              />
            ) : activeFlow ? (
              <FlowCanvas
                key={activeFlow.id}
                flow={activeFlow}
                collections={collections.collections}
                onChange={(nodes, edges) => flows.updateFlowGraph(activeFlow.id, nodes, edges)}
                rootPath={workspace.rootPath}
                environmentVariables={activeEnvironmentVariables}
                onEnvironmentChanges={environments.applyScriptChanges}
                onScopedChanges={collections.applyScopedChanges}
                onRunFinished={refreshHistory}
                onPrepareLoadRun={flows.saveNow}
                loadTestingEnabled={FEATURE_FLAGS.loadTesting}
                onEditInlineRequest={(nodeId, request) => openInlineRequest(activeFlow.id, nodeId, request)}
                externalInlineRequest={savedInlineRequest?.flowId === activeFlow.id ? savedInlineRequest : undefined}
                onEditInlineMockServer={(nodeId, server) => openTabs.openInlineMockServer(activeFlow.id, nodeId, server.name)}
                externalInlineMockServer={savedInlineMockServer?.flowId === activeFlow.id ? savedInlineMockServer : undefined}
                externalRequestChain={droppedRequestChain?.flowId === activeFlow.id ? droppedRequestChain : undefined}
              />
            ) : (
              <>
                <div className="rw-request-header">
                  <RequestBreadcrumb
                    segments={requestBreadcrumbSegments}
                    protocol={workbench.protocol}
                    actions={
                      <>
                        {activeRequestCollection ? (
                          <Tooltip label={t('runner.openButtonAria', { name: activeRequestCollection.name })}>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="rw-share-button"
                              aria-label={t('runner.openButtonAria', { name: activeRequestCollection.name })}
                              onClick={() => handleRunCollection(activeRequestCollection.id)}
                            >
                              <RunnerIcon size={12} />
                              {t('runner.openButton')}
                            </Button>
                          </Tooltip>
                        ) : (
                          <Tooltip label={t('runner.openButtonDisabled')}>
                            <Button variant="ghost" size="sm" className="rw-share-button" disabled aria-label={t('runner.openButtonDisabled')}>
                              <RunnerIcon size={12} />
                              {t('runner.openButton')}
                            </Button>
                          </Tooltip>
                        )}
                        {/* Code and image sharing only describe HTTP requests (spec 0129). */}
                        {workbench.protocol !== 'grpc' && (
                          <ShareMenu
                            onShareAsCode={() => setShareModalOpen(true)}
                            onShareAsImage={() => setScreenshotModalOpen(true)}
                          />
                        )}
                      </>
                    }
                  />
                  <EndpointBar
                    protocol={workbench.protocol}
                    method={workbench.method}
                    onMethodChange={workbench.setMethod}
                    endpointUrl={workbench.endpointUrl}
                    onEndpointUrlChange={workbench.setEndpointUrl}
                    onSend={() => void handleSend()}
                    onSendAndDownload={() => void handleSend({ download: true })}
                    onCancel={workbench.cancel}
                    isSending={workbench.execution.status === 'loading'}
                    environmentVariables={effectiveVariables}
                    routeParams={workbench.routeParams}
                    onUpdateRouteParamValue={workbench.updateRouteParam}
                    pathParameterDocs={pathParameterDocs}
                    grpcMethodPicker={
                      <GrpcMethodPicker
                        schema={workbench.grpcSchema}
                        service={workbench.grpc.service}
                        method={workbench.grpc.method}
                        onSelect={(service, method) => workbench.updateGrpc({ service, method })}
                        onLoad={(forceRefresh) => void workbench.loadGrpcSchema(forceRefresh)}
                      />
                    }
                    onPasteCommand={(command) => void importCommandIntoActiveTab(command)}
                    isImportingCommand={commandImportTabId !== null && commandImportTabId === workbench.activeTabId}
                  />
                </div>
                <div
                  ref={setRequestResponseLayout}
                  className={`rw-request-response-layout rw-request-response-layout--${effectiveResponseLayout}`}
                >
                  <section
                    className="rw-request-pane"
                    aria-label={t('workbench.tabs.requestSections')}
                    style={effectiveResponseLayout === 'right' ? { minWidth: REQUEST_PANE_MIN_WIDTH } : undefined}
                  >
                    <Tabs
                      tabs={requestTabsFor(workbench.protocol).map((tab) =>
                        tab.id === 'scripts' ? { ...tab, badge: scriptCount } : tab,
                      )}
                      activeTab={workbench.activeSection}
                      onChange={workbench.setActiveSection}
                      ariaLabel={t('workbench.tabs.requestSections')}
                    />

                    <div
                      key={`${workbench.activeSection}-${commandImportCount}`}
                      id={`tabpanel-${workbench.activeSection}`}
                      role="tabpanel"
                      aria-labelledby={`tab-${workbench.activeSection}`}
                      className={workbench.activeSection === 'query' ? 'rw-tabpanel rw-tabpanel--query ui-tabpanel-motion' : 'rw-tabpanel ui-tabpanel-motion'}
                    >
                      {workbench.activeSection === 'docs' && <DocsPanel state={requestDocs} />}
                      {workbench.activeSection === 'message' && (
                        <GrpcMessagePanel
                          key={workbench.activeTabId ?? ''}
                          service={workbench.grpc.service}
                          method={workbench.grpc.method}
                          message={workbench.grpc.message}
                          stream={workbench.grpcStream}
                          onSendMessage={() => void workbench.controlGrpcStream(false)}
                          onCloseSend={() => void workbench.controlGrpcStream(true)}
                          onMessageChange={(message) => workbench.updateGrpc({ message })}
                          schema={workbench.grpcSchema}
                          environmentVariables={effectiveVariables}
                        />
                      )}
                      {workbench.activeSection === 'query' && (
                        <div className="rw-query-layout">
                          {!queryExplorerCollapsed && (
                            <>
                              <div className="rw-query-explorer-wrapper" style={{ width: queryExplorerPanel.size }}>
                                <QueryExplorer
                                  query={workbench.query}
                                  schema={workbench.schema}
                                  onToggleField={workbench.toggleQueryField}
                                  onSetArgument={workbench.setQueryFieldArgument}
                                  onLoad={workbench.loadSchema}
                                  onCancel={workbench.cancelSchemaLoad}
                                />
                              </div>
                              <ResizeHandle
                                ariaLabel={t('workbench.resize.schemaExplorer')}
                                orientation="vertical"
                                onPointerDown={queryExplorerPanel.startResizing}
                              />
                            </>
                          )}
                          <button
                            type="button"
                            className="rw-query-explorer-handle"
                            onClick={() => setQueryExplorerCollapsed((current) => !current)}
                            aria-label={
                              queryExplorerCollapsed
                                ? t('workbench.queryExplorer.expandToggle')
                                : t('workbench.queryExplorer.collapseToggle')
                            }
                          >
                            {queryExplorerCollapsed ? <ChevronRightIcon size={12} /> : <ChevronLeftIcon size={12} />}
                          </button>
                          <QueryPanel
                            // One editor per tab keeps undo history from carrying content across tabs.
                            key={workbench.activeTabId ?? ''}
                            value={workbench.query}
                            onChange={workbench.setQuery}
                            environmentVariables={effectiveVariables}
                            schema={workbench.schema.status === 'success' ? workbench.schema.schema : null}
                          />
                        </div>
                      )}
                      {workbench.activeSection === 'query' && (
                        <QueryValidationWarnings query={workbench.query} schema={workbench.schema} />
                      )}
                      {workbench.activeSection === 'variables' && (
                        <VariablesPanel
                          key={workbench.activeTabId ?? ''}
                          value={workbench.variables}
                          onChange={workbench.setVariables}
                          environmentVariables={effectiveVariables}
                        />
                      )}
                      {workbench.activeSection === 'params' && (
                        <ParamsPanel
                          routeParams={workbench.routeParams}
                          onUpdateRouteParam={workbench.updateRouteParam}
                          onUpdateRouteParamName={workbench.updateRouteParamName}
                          onRemoveRouteParam={workbench.removeRouteParam}
                          params={workbench.params}
                          onAdd={workbench.addParam}
                          onUpdate={workbench.updateParam}
                          onRemove={workbench.removeParam}
                          onReplaceAll={workbench.replaceParams}
                          environmentVariables={effectiveVariables}
                          nameSuggestions={paramNameSuggestions}
                          valueSuggestionsFor={paramNameSuggestions ? paramValueSuggestionsFor : undefined}
                        />
                      )}
                      {workbench.activeSection === 'body' && (
                        <RestBodyPanel
                          key={workbench.activeTabId ?? ''}
                          body={workbench.body}
                          rootPath={workspace.rootPath}
                          onTypeChange={workbench.setBodyType}
                          onRawLanguageChange={workbench.setRawLanguage}
                          onRawChange={workbench.setRawBody}
                          onAddUrlEncoded={workbench.addUrlEncodedField}
                          onUpdateUrlEncoded={workbench.updateUrlEncodedField}
                          onRemoveUrlEncoded={workbench.removeUrlEncodedField}
                          onReplaceUrlEncoded={workbench.replaceUrlEncodedFields}
                          onAddFormData={workbench.addFormDataField}
                          onUpdateFormData={workbench.updateFormDataField}
                          onRemoveFormData={workbench.removeFormDataField}
                          onBinaryFileChange={workbench.setBinaryFilePath}
                          environmentVariables={effectiveVariables}
                          bodySchema={bodySchema}
                        />
                      )}
                      {workbench.activeSection === 'scripts' && (
                        <ScriptsPanel
                          editorKey={workbench.activeTabId ?? ''}
                          preRequestScript={workbench.preRequestScript}
                          postResponseScript={workbench.postResponseScript}
                          onPreRequestScriptChange={workbench.setPreRequestScript}
                          onPostResponseScriptChange={workbench.setPostResponseScript}
                          execution={workbench.execution}
                        />
                      )}
                      {workbench.activeSection === 'headers' && (
                        <HeadersPanel
                          headers={workbench.headers}
                          onAdd={workbench.addHeader}
                          onUpdate={workbench.updateHeader}
                          onRemove={workbench.removeHeader}
                          onReplaceAll={workbench.replaceHeaders}
                          environmentVariables={effectiveVariables}
                          nameSuggestions={headerNameSuggestions}
                          valueSuggestionsFor={headerNameSuggestions ? headerValueSuggestionsFor : undefined}
                          generatedHeaders={generatedHeaders}
                          overwrittenHeaderNames={headersOverwrittenByAuthorization}
                          sessionCookieCount={workbench.protocol === 'grpc' ? 0 : sessionCookies.cookies.length}
                          onOpenSessionCookies={() => setSessionCookiesModalOpen(true)}
                        />
                      )}
                      {workbench.activeSection === 'authorization' && (
                        <AuthorizationPanel
                          authorization={workbench.authorization}
                          onChange={workbench.updateAuthorization}
                          environmentVariables={effectiveVariables}
                          inheritedFrom={inheritedAuthentication}
                        />
                      )}
                      {workbench.activeSection === 'schema' && workbench.protocol === 'grpc' && (
                        <GrpcSchemaPanel
                          grpc={workbench.grpc}
                          onChange={workbench.updateGrpc}
                          schema={workbench.grpcSchema}
                          onLoad={(forceRefresh) => void workbench.loadGrpcSchema(forceRefresh)}
                          rootPath={workspace.rootPath}
                        />
                      )}
                      {workbench.activeSection === 'schema' && workbench.protocol !== 'grpc' && (
                        <SchemaPanel schema={workbench.schema} onLoad={workbench.loadSchema} onCancel={workbench.cancelSchemaLoad} />
                      )}
                    </div>
                  </section>

                  <ResizeHandle
                    ariaLabel={t('workbench.resize.response')}
                    orientation={effectiveResponseLayout === 'right' ? 'vertical' : 'horizontal'}
                    onPointerDown={activeResponsePanel.startResizing}
                  />

                  <div
                    className={`rw-response-wrapper rw-response-wrapper--${effectiveResponseLayout}`}
                    style={
                      effectiveResponseLayout === 'right' ? { width: responsePanelRight.size } : { height: responsePanel.size }
                    }
                  >
                    <ResponsePanel
                      execution={workbench.execution}
                      grpcStream={workbench.grpcStream}
                      onClear={workbench.clearResponse}
                      layout={effectiveResponseLayout}
                      onToggleLayout={onToggleResponseLayout}
                      layoutToggleDisabled={compactResponseLayout}
                      onCaptureValue={handleCaptureValue}
                      onResendWithoutLimit={handleResendWithoutLimit}
                      sendsSource={sendsSource}
                      currentSendId={workbench.activeTab.lastSendId}
                      monitor={FEATURE_FLAGS.valueMonitors ? responseMonitor : undefined}
                      onOpenHistorySettings={openGeneralSettings}
                    />
                  </div>
                </div>
              </>
            )}
            </Suspense>
            {openTabs.mockServerTabs.map((tab) => {
              const nodeRef = tab.flowNodeRef
              return (
                <MockServerEditor
                  key={tab.id}
                  rootPath={workspace.rootPath}
                  serverId={tab.serverId}
                  active={tabsRestored && barActiveTabId === tab.id}
                  onTabChange={updateMockServerTab}
                  onDeleted={() => openTabs.closeOpenTab(tab.id)}
                  inline={
                    nodeRef
                      ? {
                          server: inlineMockServerOf(flows.flows, nodeRef.flowId, nodeRef.nodeId),
                          onSave: (server) => saveInlineMockServer(nodeRef.flowId, nodeRef.nodeId, server),
                        }
                      : undefined
                  }
                />
              )
            })}
            {/* Keep inactive runner tabs mounted to receive events from ongoing runs. */}
            <Suspense fallback={null}>
            {openTabs.runnerTabs.map((runnerTab) => (
              <CollectionRunner
                key={runnerTab.id}
                tab={runnerTab}
                hidden={barActiveTabId !== runnerTab.id}
                collections={collections.collections}
                rootPath={workspace.rootPath}
                environmentVariables={activeEnvironmentVariables}
                environmentName={environments.activeEnvironment?.name ?? null}
                onBeforeRun={collections.flush}
                onEnvironmentChanges={environments.applyScriptChanges}
                onScopedChanges={collections.applyScopedChanges}
                onRunFinished={refreshHistory}
                onStepLogged={logRunnerStep}
              />
            ))}
            </Suspense>
          </main>
        </div>

        {consoleOpen && (
          <>
            <ResizeHandle
              ariaLabel={t('workbench.resize.console')}
              orientation="horizontal"
              onPointerDown={consolePanel.startResizing}
            />
            <div className="rw-console-wrapper" style={{ height: consolePanel.size }}>
              <ConsolePanel
                entries={consoleLog.entries}
                onClear={consoleLog.clear}
                onRemove={consoleLog.remove}
                onClose={() => setConsoleOpen(false)}
                tab={consoleTab}
                onTabChange={setConsoleTab}
                recorder={{
                  recording: recorder.recording,
                  exporting: harExporting,
                  redactingSensitive: redactHarSensitiveData,
                  entries: recorderEntries,
                  onStart: recorder.start,
                  onStop: recorder.stop,
                  onClear: recorder.clear,
                  onRemove: recorder.remove,
                  onSave: () => void handleSaveHar(),
                }}
              />
            </div>
          </>
        )}

        <footer className="rw-statusbar">
          <button
            type="button"
            className="rw-statusbar-recorder"
            data-recording={recorder.recording}
            aria-pressed={consoleOpen && consoleTab === 'recording'}
            aria-label={recorder.recording ? t('devConsole.recorderRecordingAria') : t('devConsole.recorderOpenAria')}
            onClick={() => openConsoleTab('recording')}
          >
            <span className="rw-statusbar-label">{t('devConsole.recorderTab')}</span>
            {recorder.entries.length > 0 && <span className="rw-statusbar-count">{recorder.entries.length}</span>}
          </button>
          <button
            type="button"
            className="rw-statusbar-console"
            aria-expanded={consoleOpen && consoleTab === 'console'}
            aria-label={consoleOpen && consoleTab === 'console' ? t('devConsole.closeAria') : t('devConsole.openAria')}
            onClick={() => openConsoleTab('console')}
          >
            <span className="rw-statusbar-label">{t('devConsole.title')}</span>
          </button>
          <div id="rw-import-statusbar-slot" className="rw-statusbar-import-slot" />
          <div className="rw-statusbar-end">
            {FEATURE_FLAGS.gitlab && (
              <GitStatusButton
                summary={versionControl.summary}
                counts={versionControl.counts}
                link={versionControl.link}
                checking={versionControl.checking}
                busy={versionControl.busy}
                onPull={() => setPullReviewOpen(true)}
                onRefresh={() => void versionControl.refresh()}
                onOpenPanel={() => {
                  setSidebarTab('git')
                  if (sidebarCollapsed) setSidebarCollapsed(false)
                }}
              />
            )}
            {proxy.settings.mode !== 'disabled' && (
              <>
                <button
                  type="button"
                  className="rw-statusbar-proxy"
                  data-error={proxy.applyError !== null}
                  aria-label={t('proxy.statusbar.aria', { mode: proxyModeLabel })}
                  {...proxyTooltipProps}
                  onClick={() => {
                    setSettingsCategory('network')
                    setSettingsOpen(true)
                  }}
                >
                  <ProxyIcon size={14} />
                  <span className="rw-statusbar-label">{t('proxy.statusbar.label')}</span>
                  <span className="rw-statusbar-proxy-dot" aria-hidden="true" />
                </button>
                {proxyTooltipElement}
              </>
            )}
            {FEATURE_FLAGS.updates && (
              <UpdateStatusIndicator
                onOpen={() => {
                  setSettingsCategory('updates')
                  setSettingsOpen(true)
                }}
              />
            )}
            {FEATURE_FLAGS.notifications && (
              <>
                <span className="rw-statusbar-divider" aria-hidden="true" />
                <NotificationsButton notifications={notifications} onOpenDetails={handleOpenNotification} />
              </>
            )}
          </div>
        </footer>

        {isResizingAny && <div className="resize-drag-overlay" style={{ cursor: resizeCursor }} />}

        {newRequestPopover && (
          <NewRequestPopover
            anchor={newRequestPopover.anchor}
            onClose={closeNewRequestPopover}
            onSelect={(protocol) => {
              // Bring the new request in front of active runner/notification tabs.
              closeRunLogPreview()
              workbench.newDraftTab(protocol, t('collections.newRequestName'))
              setNewRequestPopover(null)
            }}
            onCreateCollection={
              newRequestPopover.fromSidebar
                ? () => {
                    runCollectionsCommand({ kind: 'rename', id: collections.addCollection() })
                    setNewRequestPopover(null)
                  }
                : undefined
            }
          />
        )}

        {sessionCookiesModalOpen && (
          <SessionCookiesModal
            cookies={sessionCookies.cookies}
            onDelete={(cookie) => void sessionCookies.remove(cookie)}
            onClearAll={() => void sessionCookies.clear()}
            onClose={() => setSessionCookiesModalOpen(false)}
          />
        )}

        {saveModalOpen && (
          <SaveRequestModal
            collections={collections.collections}
            initialName={workbench.activeTab.name}
            onClose={() => setSaveModalOpen(false)}
            onSave={handleSaveAs}
            onCreateCollection={collections.addCollection}
            onCreateFolder={collections.addFolder}
          />
        )}

        <Suspense fallback={null}>
        {shareModalOpen && (
          <ShareRequestModal
            tab={workbench.activeTab}
            inheritedAuthentication={inheritedAuthentication?.authentication}
            environmentVariables={effectiveVariables}
            onClose={() => setShareModalOpen(false)}
          />
        )}
        </Suspense>

        {!activePseudoTab?.capturesInput && <ImageImportDropOverlay onImportFromPath={importFromPath} />}

        <Suspense fallback={null}>
        {screenshotModalOpen && (
          <ShareScreenshotModal
            tab={workbench.activeTab}
            execution={workbench.execution}
            inheritedAuthentication={inheritedAuthentication?.authentication}
            environmentVariables={effectiveVariables}
            requestName={workbench.activeTab.name}
            environmentName={environments.activeEnvironment?.name ?? null}
            onClose={() => setScreenshotModalOpen(false)}
          />
        )}

        {pullReviewOpen && (
          <PullReviewModal rootPath={workspace.rootPath} vc={versionControl} onClose={() => setPullReviewOpen(false)} />
        )}

        {FEATURE_FLAGS.webclientExport && webclientExportSelection && (
          <ExportWebclientModal
            source={webclientExportSelection}
            environments={environments.environments}
            activeEnvironmentId={environments.activeEnvironmentId}
            onClose={() => setWebclientExportId(null)}
          />
        )}
        </Suspense>
      </div>
    </VariableEditingContext>
  )
}
