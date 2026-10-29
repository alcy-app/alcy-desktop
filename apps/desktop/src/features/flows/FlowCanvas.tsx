import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAgentResourceController, type AgentResourceBridge } from '../agent/agent-resource-bridge'
import { dtoFromFlow, flowFromDto } from './use-flows-state'
import { FlowFormView } from './FlowFormView'
import { FlowPanels } from './FlowPanels'
import { FlowTabs } from './FlowTabs'
import { initialFormAnswers } from './form-model'
import { submitFlowForm } from '../../bindings/flow-forms'
import type { FlowPresentation, FormAnswers } from '../../bindings/flow-forms'
import { DisplayOutput } from './DisplayOutput'
import { describeRunStatus } from './node-run-status'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ScopedVariableChange } from '../../bindings/execute-graphql-request'
import { addEdge, Background, BackgroundVariant, ConnectionLineType, Controls, Panel, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react'
import type { Connection, Edge, FinalConnectionState, ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import type { MockServerDto } from '../../bindings/mock-servers'
import { copyLoadDatasetAsset } from '../../bindings/copy-load-dataset-asset'
import { pickDataFile } from '../../bindings/pick-data-file'
import { previewLoadFlow } from '../../bindings/preview-load-flow'
import type { LoadFlowPreviewDto } from '../../bindings/preview-load-flow'
import { useLanguage } from '../../shared/i18n/use-language'
import { Badge } from '../../shared/ui/Badge'
import { Button } from '../../shared/ui/Button'
import { Modal } from '../../shared/ui/Modal'
import { PlusIcon, Spinner } from '../../shared/ui/icons'
import { useToast } from '../../shared/ui/use-toast'
import { hasOpenModal } from '../../shared/ui/open-modals'
import { comboFromEvent, comboFromMouseEvent, isShortcutFor } from '../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../shared/shortcuts/use-shortcuts'
import { findRequest, findRequestPath, mergeScopedVariables, requestMethodLabel } from '../request-workbench/collection-tree'
import type { RequestContent, RequestSummary, TreeNode } from '../request-workbench/collection-tree'
import type { ConsoleEntryInput } from '../request-workbench/use-console-state'
import { BlockPalette } from './BlockPalette'
import type { PaletteKind } from './BlockPalette'
import type { FlowEdgeType } from './flow-edge-types'
import { isFlowSourceHandle, isSimpleNodeKind } from './flows.types'
import type { ConditionState, FlowEdgeState, FlowNodeState, FlowSourceHandle, FlowState, LoadNodeKindState, SimpleNodeKindState } from './flows.types'
import { RunLogPanel } from './RunLogPanel'
import type { RunLogNodeInfo } from './RunLogPanel'
import { NodeInspectorPanel } from './NodeInspectorPanel'
import type { AncestorRequestRef, InspectorSelection } from './NodeInspectorPanel'
import { edgeMarker, isSimpleFlowNode, snapViewportToWholePixels, terminalFlowNodeIds, toFlowEdges, toFlowNodes } from './flow-canvas-mapping'
import type { FlowNode } from './flow-canvas-mapping'
import { edgeTypes, nodeTypes } from './flow-node-types'
import { buildRequestChain, startWithoutOutput } from './request-chain'
import { isVisitedStatus } from './flow-run-trail'
import { whilesWithOpenBody } from './loop-body'
import { configOfSimpleNode, defaultSimpleNodeConfig, newInlineRequest, simpleFlowNode, simpleNodeLogInfo } from './simple-node-types'
import { useFlowRun } from './use-flow-run'
import { consoleEntryFromFlowCall } from './flow-call-recording'
import type { FlowRecordedCall } from './flow-call-recording'
import { LoadRunResults } from './LoadRunResults'
import { useLoadFlowRun } from './use-load-flow-run'
import { EXECUTABLE_LOAD_NODE_KINDS, defaultLoadNodeConfig, defaultLoadNodeLabel } from './load-node-config'
import { defaultMockStartNodeId, findMockRoute, mockRouteLabel, resolveMockStarts, savedMockServerIds } from './mock-nodes'
import type { MockStartInfo } from './mock-nodes'
import { useFlowMockServers } from './use-flow-mock-servers'
import './flow-canvas.css'
import './flow-studio.css'
import { FlowMappingProvider } from './flow-mapping'
import { FlowRequestEditor } from './FlowRequestEditor'
import type { FlowVariableDefinition } from './FlowDataBrowser'
import { availableNodePosition } from './new-node-position'
import type { FlowDatasetSource } from './FlowDatasetFields'
import { availableNodeIdentifier, identifierError, renameGraphNode, renameNodeReferences } from './node-identifiers'
import { FLOW_GEOMETRY as G, flowGeometryStyle, flowNodeSize } from './flow-geometry'
import { flowLayoutModel } from './flow-layout-model'
import { branchOrder, flowEdgeRoutes } from './flow-layout'
import { useFlowLayout } from './use-flow-layout'
import { isDisplayFormat } from './display-format'
import type { DisplayFormat } from './display-format'
import { displayBodyNodeId } from './display-output-source'


const DEFAULT_CONDITION: ConditionState = { left: '', operator: 'equals', right: '' }

function fromFlowNodes(nodes: FlowNode[]): FlowNodeState[] {
  return nodes.map((node): FlowNodeState => {
    if (isSimpleFlowNode(node)) {
      return { id: node.id, ...configOfSimpleNode(node), position: node.position }
    }
    if (node.type === 'start') {
      return { id: node.id, kind: 'start', ...(node.data.form ? { form: node.data.form } : {}), position: node.position }
    }
    if (node.type === 'request') {
      return {
        id: node.id,
        kind: 'request',
        requestId: (node.data as { requestId: string }).requestId,
        position: node.position,
      }
    }
    if (node.type === 'if') {
      return {
        id: node.id,
        kind: 'if',
        condition: (node.data as { condition: ConditionState }).condition,
        position: node.position,
      }
    }
    if (node.type === 'block' && node.data.loadKind) {
      return {
        id: node.id,
        kind: 'load',
        loadKind: node.data.loadKind as LoadNodeKindState,
        label: node.data.label,
        config: node.data.loadConfig ?? '{}',
        position: node.position,
      }
    }
    return { id: node.id, kind: 'block', label: (node.data as { label: string }).label, position: node.position }
  })
}

function fromFlowEdges(edges: Edge[]): FlowEdgeState[] {
  return edges.map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.source,
    targetNodeId: edge.target,
    sourceHandle: isFlowSourceHandle(edge.sourceHandle) ? edge.sourceHandle : undefined,
  }))
}

/** Reverse BFS for presentation only; the execution engine remains responsible for validating ancestor references. */
function computeAncestorIds(nodeId: string, edges: Edge[]): Set<string> {
  const incoming = new Map<string, string[]>()
  edges.forEach((edge) => {
    const list = incoming.get(edge.target) ?? []
    list.push(edge.source)
    incoming.set(edge.target, list)
  })

  const visited = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const source of incoming.get(current) ?? []) {
      if (!visited.has(source)) {
        visited.add(source)
        queue.push(source)
      }
    }
  }

  return visited
}

/** Referenceable outputs exposed by ancestor request and mock nodes. */
function computeAncestorRequestRefs(ancestorIds: Set<string>, nodes: FlowNode[]): AncestorRequestRef[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const refs: AncestorRequestRef[] = []
  ancestorIds.forEach((ancestorId) => {
    const node = byId.get(ancestorId)
    if (!node) return
    if (isSimpleFlowNode(node) && node.data.config.kind === 'inlineRequest') {
      refs.push({ nodeId: ancestorId, label: node.data.config.request.name || ancestorId.slice(0, 8) })
      return
    }
    if (isSimpleFlowNode(node) && node.data.config.kind === 'mockStart') {
      refs.push({ nodeId: ancestorId, label: node.data.mockStart?.name || ancestorId.slice(0, 8), output: 'mockServer' })
      return
    }
    if (isSimpleFlowNode(node) && node.data.config.kind === 'mockWaitRequest') {
      const route = findMockRoute(node.data.mockStart?.server ?? null, node.data.config.routeId)
      refs.push({ nodeId: ancestorId, label: route ? mockRouteLabel(route) : ancestorId.slice(0, 8), output: 'mockRequest' })
      return
    }
    if (node.type !== 'request') return
    const request = (node.data as { request: RequestSummary | null }).request
    refs.push({ nodeId: ancestorId, label: request?.name || ancestorId.slice(0, 8) })
  })
  return refs
}

/** Local variable names declared by ancestor Set variables nodes. */
function computeAncestorLocalVariables(ancestorIds: Set<string>, nodes: FlowNode[]): string[] {
  const names = new Set<string>()
  for (const node of nodes) {
    if (!ancestorIds.has(node.id)) continue
    const form = node.type === 'start' ? node.data.form : isSimpleFlowNode(node) && node.data.config.kind === 'humanAction' ? node.data.config.form : null
    if (form) for (const field of form.sections.flatMap((section) => section.fields)) {
      names.add(`nodes.${node.id}.form.${field.id}`)
      if (field.kind === 'result') for (const column of field.source?.columns ?? []) if (column.path) names.add(`nodes.${node.id}.form.${field.id}.${field.multiple ? '0.' : ''}${column.path}`)
    }
    if (!isSimpleFlowNode(node) || node.data.config.kind !== 'setVariables') continue
    for (const assignment of node.data.config.assignments) {
      const name = assignment.name.trim()
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

function isMockKind(kind: string): boolean {
  return kind.startsWith('mock')
}

/** Resolve the mock started by this node or referenced by a dependent mock node (spec 0121). */
function mockStartFor(nodeId: string, config: SimpleNodeKindState, mockStarts: Record<string, MockStartInfo>): MockStartInfo | null {
  if (config.kind === 'mockStart') return mockStarts[nodeId] ?? null
  if ('startNodeId' in config) return mockStarts[config.startNodeId] ?? null
  return null
}

function selectedMockStart(selection: InspectorSelection, mockStarts: Record<string, MockStartInfo>): MockStartInfo | null {
  if (selection.kind === 'mockStart') return mockStarts[selection.id] ?? null
  if ('startNodeId' in selection) return mockStarts[selection.startNodeId] ?? null
  return null
}

const NON_TEXT_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'file', 'checkbox', 'radio', 'color', 'range'])

/** Text-entry controls own their keystrokes rather than triggering canvas shortcuts. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type)
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

interface PaletteTrigger {
  anchor: DOMRect
  /** Absent for toolbar actions; present when a connection is released on the empty canvas. */
  sourceNodeId: string | null
  /** The named output that the automatically created edge must preserve. */
  sourceHandle?: FlowSourceHandle
  /** Connection drop or shortcut position in flow coordinates. */
  dropPosition?: { x: number; y: number }
}

interface FlowCanvasProps {
  agentBridge?: AgentResourceBridge
  onPresentationChange?: (presentation: FlowPresentation) => void
  onRenameNode?: (previous: string, next: string) => void
  requestSaving?: boolean
  requestDrafts?: Record<string, RequestContent>
  onRequestDraftChange?: (nodeId: string, request: RequestSummary, content: RequestContent, inline: boolean) => void
  onSaveRequestDrafts?: (updates: { nodeId: string; request: RequestSummary; inline: boolean }[], graph: { nodes: FlowNodeState[]; edges: FlowEdgeState[] }) => Promise<void>
  onDiscardRequestDrafts?: (nodeIds: string[]) => void
  onPrepareRun?: () => Promise<void>
  flow: FlowState
  collections: TreeNode[]
  onChange: (nodes: FlowNodeState[], edges: FlowEdgeState[]) => void
  rootPath: string
  environmentVariables: EnvironmentVariableDto[]
  onEnvironmentChanges?: (changes: { name: string; value: string | null }[]) => void
  onScopedChanges?: (changes: ScopedVariableChange[]) => void
  /** Called after the backend has persisted a completed run. */
  onRunFinished?: () => void
  /** Persist the canvas before the preview or executor reloads the flow by ID. */
  onPrepareLoadRun?: () => Promise<void>
  /** The workbench controls this experimental capability; persisted load flows cannot execute without it. */
  loadTestingEnabled?: boolean
  /** Fallback action for opening an inline request in a workbench tab (spec 0086). */
  onEditInlineRequest?: (nodeId: string, request: RequestSummary) => void
  /** An inline request saved elsewhere; apply each revision once to prevent subsequent graph updates from restoring stale content. */
  externalInlineRequest?: { nodeId: string; request: RequestSummary; revision: number }
  /** Open the inline mock of a Start mock block in a workbench tab (spec 0121). */
  onEditInlineMockServer?: (nodeId: string, server: MockServerDto) => void
  /** Inline mock saved by a workbench tab; follows the same revision mechanism as inline requests. */
  externalInlineMockServer?: { nodeId: string; server: MockServerDto; revision: number }
  /** Requests dropped from the collection tree, with screen coordinates; apply each revision once (spec 0095). */
  externalRequestChain?: { requestIds: string[]; clientPoint: { x: number; y: number }; revision: number }
  /** HAR recorder on: runs started now report each request node call to `onCallRecorded`. */
  recordingCalls?: boolean
  onCallRecorded?: (entry: ConsoleEntryInput) => void
}

/** Flow graph editing and execution. Mount with key={flow.id}: React Flow state hooks consume initial values once, so switching flows requires a fresh instance. */
export function FlowCanvas({
  agentBridge,
  onPresentationChange,
  onRenameNode,
  requestSaving = false,
  requestDrafts = {}, onRequestDraftChange, onSaveRequestDrafts, onDiscardRequestDrafts, onPrepareRun,
  flow,
  collections,
  onChange,
  rootPath,
  environmentVariables,
  onEnvironmentChanges,
  onScopedChanges,
  onRunFinished,
  onPrepareLoadRun,
  loadTestingEnabled = false,
  onEditInlineRequest,
  externalInlineRequest,
  onEditInlineMockServer,
  externalInlineMockServer,
  externalRequestChain,
  recordingCalls = false,
  onCallRecorded,
}: FlowCanvasProps) {
  const { t } = useLanguage()
  const { bindings: shortcutBindings } = useShortcuts()
  const { showToast } = useToast()
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(toFlowNodes(flow.nodes))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(flow.edges))
  const [paletteTrigger, setPaletteTrigger] = useState<PaletteTrigger | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [mappingNodeId, setMappingNodeId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [initialFormOpen, setInitialFormOpen] = useState(false)
  const pendingInitialAnswers = useRef<FormAnswers | undefined>(undefined)
  const [humanFormNodeId, setHumanFormNodeId] = useState<string | null>(null)
  const [presentation, setPresentation] = useState<FlowPresentation>(flow.presentation ?? { panels: [] })
  const changePresentation = (next: FlowPresentation) => { setPresentation(next); onPresentationChange?.(next) }
  const [inspectorTab, setInspectorTab] = useState<'configuration' | 'data' | 'output'>('configuration')
  const [pendingRun, setPendingRun] = useState(false)
  const [runAfterSave, setRunAfterSave] = useState(false)
  const [savingDrafts, setSavingDrafts] = useState(false)
  const [executedSignature, setExecutedSignature] = useState<string | null>(null)
  const [displayFormats, setDisplayFormats] = useState<Record<string, DisplayFormat>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`alcy:flows:${flow.id}:display-formats`) ?? '{}')
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, DisplayFormat] => isDisplayFormat(entry[1])))
    } catch { return {} }
  })
  const setDisplayFormat = useCallback((nodeId: string, format: DisplayFormat) => {
    setDisplayFormats((current) => ({ ...current, [nodeId]: format }))
  }, [])
  useEffect(() => {
    try { localStorage.setItem(`alcy:flows:${flow.id}:display-formats`, JSON.stringify(displayFormats)) } catch { /* Preferences remain usable in memory. */ }
  }, [displayFormats, flow.id])
  const [loadPreview, setLoadPreview] = useState<LoadFlowPreviewDto | null>(null)
  const [loadingLoadPreview, setLoadingLoadPreview] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const reactFlowInstanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdgeType> | null>(null)
  const organization = useFlowLayout(nodes, edges, setNodes,
    () => { void reactFlowInstanceRef.current?.fitView({ nodes: nodes.filter((node) => node.type !== 'note').map(({ id }) => ({ id })), maxZoom: 1, padding: 0.2 }) },
    () => showToast(t('flows.canvas.organizeFailed'), 'error'))

  // Resolve each mock block against its Start mock node (spec 0121).
  const simpleConfigs = useMemo(
    () => nodes.filter(isSimpleFlowNode).map((node) => ({ id: node.id, config: node.data.config })),
    [nodes],
  )
  const flowMockServers = useFlowMockServers(
    rootPath,
    savedMockServerIds(simpleConfigs.map((node) => node.config)),
  )
  const mockStarts = useMemo(
    () => resolveMockStarts(simpleConfigs, flowMockServers.savedServers),
    [simpleConfigs, flowMockServers.savedServers],
  )

  // Runs on event delivery, after `latestGraphRef` below holds the current graph.
  const recordCall = (call: FlowRecordedCall) => {
    if (!onCallRecorded) return
    const node = latestGraphRef.current.nodes.find((candidate) => candidate.id === call.nodeId)
    const request =
      node?.type === 'request'
        ? node.data.requestId ? findRequest(collections, node.data.requestId) : null
        : node && isSimpleFlowNode(node) && node.data.config.kind === 'inlineRequest'
          ? node.data.config.request
          : null
    onCallRecorded(consoleEntryFromFlowCall(call, request))
  }
  const standardRun = useFlowRun({
    flowId: flow.id,
    rootPath,
    flowName: flow.name,
    onRunFinished,
    onEnvironmentChanges,
    onScopedChanges,
    recordExchanges: recordingCalls && onCallRecorded !== undefined,
    onCall: recordCall,
    nodes: fromFlowNodes(nodes),
    edges: fromFlowEdges(edges),
    environmentVariables,
  })
  const loadRun = useLoadFlowRun(rootPath, flow.id, onRunFinished)
  const importDatasetAsset = useCallback(async () => {
    const sourcePath = await pickDataFile()
    if (!sourcePath) return null
    const copied = await copyLoadDatasetAsset(rootPath, flow.id, sourcePath)
    if (!copied.ok) {
      const message = copied.error.kind === 'notFound' ? t('flows.loadNode.dataset.flowNotFound') : copied.error.message
      showToast(t('flows.canvas.runErrorToast', { message }), 'error')
      return null
    }
    return copied.value
  }, [flow.id, rootPath, showToast, t])
  const isLoadFlow = flow.executionKind === 'load'
  const isRunning = isLoadFlow ? loadRun.isRunning : standardRun.isRunning
  const cancel = isLoadFlow ? loadRun.cancel : standardRun.cancel
  const { statuses: executionStatuses, traversedEdges, logEntries, runStartedAtMs, flowExecutionId, run } = standardRun
  const { viewMode, setViewMode } = standardRun
  const { snapshotNodeIds, setSnapshotNodeIds } = standardRun
  const statuses = useMemo(() => ({ ...executionStatuses, ...Object.fromEntries(Object.entries(snapshotNodeIds).flatMap(([id, snapshot]) => executionStatuses[snapshot] ? [[id, executionStatuses[snapshot]]] : [])) }), [executionStatuses, snapshotNodeIds])
  const outputVersions = useMemo(() => {
    const versions: Record<string, number> = {}
    for (const entry of logEntries) if (entry.finishedAtMs !== null) versions[entry.nodeId] = (versions[entry.nodeId] ?? 0) + 1
    for (const [nodeId, snapshotId] of Object.entries(snapshotNodeIds)) versions[nodeId] = versions[snapshotId] ?? 0
    return versions
  }, [logEntries, snapshotNodeIds])

  const onChangeRef = useRef(onChange)
  const latestGraphRef = useRef({ nodes, edges })
  const pendingChangeRef = useRef(false)
  useEffect(() => {
    onChangeRef.current = onChange
    latestGraphRef.current = { nodes, edges }
  })

  const flushChange = useCallback(() => {
    if (!pendingChangeRef.current) return
    pendingChangeRef.current = false
    onChangeRef.current(fromFlowNodes(latestGraphRef.current.nodes), fromFlowEdges(latestGraphRef.current.edges))
  }, [])

  // React Flow deletion respects non-deletable Start nodes and removes connected edges together with the node.
  const deleteNode = useCallback((nodeId: string) => {
    void reactFlowInstanceRef.current?.deleteElements({ nodes: [{ id: nodeId }] })
  }, [])

  // Duplicate canonical node data with an offset and no edges. Start nodes never expose duplication.
  const duplicateNode = useCallback((nodeId: string) => {
    setNodes((current) => {
      const source = current.find((node) => node.id === nodeId)
      if (!source) return current
      const newId = availableNodeIdentifier(source.id.length <= 48 ? source.id : source.type ?? 'node', current)
      const position = availableNodePosition({ x: source.position.x + 40, y: source.position.y + 40 }, current)
      if (isSimpleFlowNode(source)) {
        return [...current, simpleFlowNode(newId, position, configOfSimpleNode(source))]
      }
      if (source.type === 'block') {
        return [
          ...current,
          {
            id: newId,
            type: 'block',
            position,
            data: {
              label: source.data.label,
              ...(source.data.loadKind ? { loadKind: source.data.loadKind, loadConfig: source.data.loadConfig } : {}),
              onOpenSettings: () => {},
              onDelete: () => {},
              onDuplicate: () => {},
            },
          },
        ]
      }
      if (source.type === 'request') {
        return [
          ...current,
          {
            id: newId,
            type: 'request',
            position,
            data: {
              requestId: source.data.requestId,
              request: null,
              runStatus: { status: 'idle' },
              collections: [],
              environmentVariables: [],
              onSelectRequest: () => {},
              onOpenSettings: () => {},
              onDelete: () => {},
              onDuplicate: () => {},
            },
          },
        ]
      }
      if (source.type === 'if') {
        return [
          ...current,
          {
            id: newId,
            type: 'if',
            position,
            data: {
              condition: source.data.condition,
              runStatus: { status: 'idle' },
              onOpenSettings: () => {},
              onDelete: () => {},
              onDuplicate: () => {},
            },
          },
        ]
      }
      return current
    })
  }, [setNodes])

  // Request selection changes only requestId; renderNodes resolves the collection request live.
  const setRequestForNode = useCallback(
    (nodeId: string, request: RequestSummary) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId && node.type === 'request' ? { ...node, data: { ...node.data, requestId: request.id } } : node,
        ),
      )
    },
    [setNodes],
  )

  // Apply an If condition edited in the inspector or quick editor.
  const setConditionForNode = useCallback(
    (nodeId: string, condition: ConditionState) => {
      setNodes((current) =>
        current.map((node) => (node.id === nodeId && node.type === 'if' ? { ...node, data: { ...node.data, condition } } : node)),
      )
    },
    [setNodes],
  )

  // Update a simple node from the inspector or direct note editing (spec 0083).
  const setConfigForNode = useCallback(
    (nodeId: string, config: SimpleNodeKindState) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === nodeId && isSimpleFlowNode(node) && node.type === config.kind ? { ...node, data: { ...node.data, config } } : node,
        ),
      )
    },
    [setNodes],
  )

  const setLoadConfigForNode = useCallback(
    (nodeId: string, config: string) => {
      setNodes((current) => current.map((node) =>
        node.id === nodeId && node.type === 'block' && node.data.loadKind
          ? { ...node, data: { ...node.data, loadConfig: config } }
          : node,
      ))
    },
    [setNodes],
  )

  // Open the inline request in the inspector, with a workbench fallback for older consumers.
  const editInlineRequest = useCallback(
    (nodeId: string) => {
      const node = latestGraphRef.current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || !isSimpleFlowNode(node) || node.data.config.kind !== 'inlineRequest') return
      flushChange()
      if (onRequestDraftChange) { setSelectedNodeId(nodeId); setMappingNodeId(nodeId); setInspectorTab('configuration') }
      else onEditInlineRequest?.(nodeId, node.data.config.request)
    },
    [flushChange, onEditInlineRequest, onRequestDraftChange],
  )

  // Open the inline mock using its current node configuration.
  const editInlineMockServer = useCallback(
    (nodeId: string) => {
      const node = latestGraphRef.current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || !isSimpleFlowNode(node) || node.data.config.kind !== 'mockStart' || node.data.config.source.type !== 'inline') return
      flushChange()
      onEditInlineMockServer?.(nodeId, node.data.config.source.server)
    },
    [flushChange, onEditInlineMockServer],
  )

  // Resolve collection requests live so renames and content edits appear immediately. Dragging updates canonical nodes; execution decorations belong only to this derived view.
  const terminalIds = useMemo(() => terminalFlowNodeIds(nodes, edges), [nodes, edges])
  const renderNodes = useMemo<FlowNode[]>(
    () =>
      nodes.map((canonical): FlowNode => {
        const node = { ...canonical, className: [canonical.className, terminalIds.has(canonical.id) ? 'flow-terminal-node' : ''].filter(Boolean).join(' ') }
        const onDelete = () => deleteNode(node.id)
        const onOpenSettings = () => { setSelectedNodeId(node.id); setMappingNodeId(node.id); setInspectorTab('configuration') }
        const onDuplicate = () => duplicateNode(node.id)
        const visited = node.type === 'start' ? traversedEdges.size > 0 : isVisitedStatus(statuses[node.id])
        if (isSimpleFlowNode(node)) {
          const sourceId = node.data.config.kind === 'display' ? displayBodyNodeId(node.data.config.template) : null
          return {
            ...node,
            data: {
              ...node.data,
              runStatus: statuses[node.id] ?? { status: 'idle' },
              visited,
              onOpenSettings,
              onDelete,
              onDuplicate,
              onConfigChange: (config: SimpleNodeKindState) => setConfigForNode(node.id, config),
              displayFormat: displayFormats[node.id] ?? 'auto',
              onDisplayFormatChange: (format: DisplayFormat) => setDisplayFormat(node.id, format),
              displaySource: sourceId && flowExecutionId ? { rootPath, flowExecutionId, nodeId: snapshotNodeIds[sourceId] ?? sourceId, version: outputVersions[sourceId] ?? 0 } : undefined,
              ...(node.data.config.kind === 'inlineRequest'
                ? { onEditRequest: () => editInlineRequest(node.id), environmentVariables }
                : {}),
              ...(isMockKind(node.data.config.kind) ? { mockStart: mockStartFor(node.id, node.data.config, mockStarts) } : {}),
              ...(node.data.config.kind === 'mockStart' ? { onEditMockServer: () => editInlineMockServer(node.id) } : {}),
            },
          }
        }
        if (node.type === 'request') {
          const requestId = node.data.requestId
          const onSelectRequest = (request: RequestSummary) => setRequestForNode(node.id, request)
          return {
            ...node,
            data: {
              requestId,
              request: requestId ? findRequest(collections, requestId) : null,
              runStatus: statuses[node.id] ?? { status: 'idle' },
              visited,
              collections,
              environmentVariables,
              onSelectRequest,
              onOpenSettings,
              onDelete,
              onDuplicate,
            },
          }
        }
        if (node.type === 'if') {
          return {
            ...node,
            data: {
              condition: node.data.condition,
              onConditionChange: (condition: ConditionState) => setConditionForNode(node.id, condition),
              runStatus: statuses[node.id] ?? { status: 'idle' },
              visited,
              onOpenSettings,
              onDelete,
              onDuplicate,
            },
          }
        }
        if (node.type === 'block') {
          return {
            ...node,
            data: {
              label: node.data.label,
              ...(node.data.loadKind ? { loadKind: node.data.loadKind, loadConfig: node.data.loadConfig } : {}),
              visited,
              onOpenSettings,
              onDelete,
              onDuplicate,
            },
          }
        }
        return { ...node, data: { ...node.data, visited, onOpenSettings } }
      }),
    [
      nodes,
      collections,
      environmentVariables,
      displayFormats,
      terminalIds,
      setDisplayFormat,
      rootPath,
      flowExecutionId,
      snapshotNodeIds,
      outputVersions,
      setConditionForNode,
      statuses,
      traversedEdges,
      deleteNode,
      duplicateNode,
      setRequestForNode,
      setConfigForNode,
      editInlineRequest,
      editInlineMockServer,
      mockStarts,
    ],
  )

  const runLogNodeInfo = useMemo<Record<string, RunLogNodeInfo>>(() => {
    const info: Record<string, RunLogNodeInfo> = {}
    for (const node of renderNodes) {
      if (isSimpleFlowNode(node)) {
        info[node.id] = simpleNodeLogInfo(node.data.config, t)
      } else if (node.type === 'start') {
        info[node.id] = { label: t('flows.canvas.startNodeLabel'), kindLabel: '' }
      } else if (node.type === 'block') {
        info[node.id] = { label: node.data.label, kindLabel: t('flows.canvas.newBlockLabel') }
      } else if (node.type === 'if') {
        info[node.id] = { label: t('flows.canvas.ifNodeLabel'), kindLabel: t('flows.canvas.newIfBlockLabel') }
      } else if (node.type === 'request') {
        const request = node.data.request
        info[node.id] = {
          label: request ? request.name || t('common.unnamed') : node.id.slice(0, 8),
          kindLabel: t('flows.canvas.newRequestBlockLabel'),
          request: request
            ? `${requestMethodLabel(request)} ${request.content.endpointUrl}`
            : undefined,
        }
      }
    }
    return info
  }, [renderNodes, t])

  const handleRun = useCallback((initialAnswers?: FormAnswers) => {
    const start = fromFlowNodes(nodes).find((node) => node.kind === 'start')
    if (!isLoadFlow && start?.kind === 'start' && start.form && initialAnswers === undefined) {
      setInitialFormOpen(true)
      return
    }
    setInitialFormOpen(false)
    if (onPrepareRun && !isLoadFlow) {
      setLoadingLoadPreview(true)
      void onPrepareRun().then(() => { setLogOpen(viewMode !== 'panels'); run(initialAnswers) }).catch((reason: unknown) => showToast(t('flows.canvas.runErrorToast', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')).finally(() => setLoadingLoadPreview(false))
      return
    }
    if (flow.executionKind === 'load') {
      if (!loadTestingEnabled) return
      setLoadingLoadPreview(true)
      void (async () => {
        try {
          await onPrepareLoadRun?.()
          const preview = await previewLoadFlow(rootPath, flow.id)
          if (preview.ok) {
            setLoadPreview(preview.value)
          } else {
            const message = preview.error.kind === 'invalid' || preview.error.kind === 'storage' ? preview.error.message : t('flows.loadRun.notFound')
            showToast(t('flows.canvas.runErrorToast', { message }), 'error')
          }
        } finally {
          setLoadingLoadPreview(false)
        }
      })()
      return
    }
    setLogOpen(viewMode !== 'panels')
    run(initialAnswers)
  }, [nodes, viewMode, flow.executionKind, flow.id, loadTestingEnabled, onPrepareLoadRun, onPrepareRun, isLoadFlow, rootPath, run, showToast, t])

  const removeEdge = useCallback(
    (edgeId: string) => {
      setEdges((current) => current.filter((edge) => edge.id !== edgeId))
    },
    [setEdges],
  )

  // An edge is active while its target request node is executing.
  const edgeRoutes = useMemo(() => flowEdgeRoutes(flowLayoutModel(nodes, edges)), [nodes, edges])
  const renderEdges = useMemo<FlowEdgeType[]>(
    () =>
      edges.map((edge, index) => ({
        ...edge,
        data: {
          onDelete: () => removeEdge(edge.id),
          active: statuses[edge.target]?.status === 'running',
          traversed: traversedEdges.has(edge.id),
          hovered: edge.id === hoveredEdgeId,
          ...edgeRoutes[index],
        },
      })),
    [edges, statuses, traversedEdges, hoveredEdgeId, removeEdge, edgeRoutes],
  )

  // Use React Flow's edge hover events instead of a separate invisible path; see FlowEdge.tsx.
  const onEdgeMouseEnter = useCallback((_event: ReactMouseEvent, edge: FlowEdgeType) => setHoveredEdgeId(edge.id), [])
  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), [])

  const selection = useMemo<InspectorSelection | null>(() => {
    if (!selectedNodeId) return null
    const node = renderNodes.find((current) => current.id === selectedNodeId)
    if (!node) return null
    if (isSimpleFlowNode(node)) return { id: node.id, ...configOfSimpleNode(node) }
    if (node.type === 'start') return { id: node.id, kind: 'start', form: node.data.form }
    if (node.type === 'block' && node.data.loadKind) {
      return { id: node.id, kind: 'load', loadKind: node.data.loadKind as LoadNodeKindState, label: node.data.label, config: node.data.loadConfig ?? '{}' }
    }
    if (node.type === 'block') return { id: node.id, kind: 'block', label: (node.data as { label: string }).label }
    if (node.type === 'if') return { id: node.id, kind: 'if', condition: (node.data as { condition: ConditionState }).condition }
    const requestData = node.data as { requestId: string; request: RequestSummary | null }
    return { id: node.id, kind: 'request', requestId: requestData.requestId, request: requestData.request }
  }, [selectedNodeId, renderNodes])

  const ancestorIds = useMemo(() => (selection ? computeAncestorIds(selection.id, edges) : new Set<string>()), [selection, edges])
  const ancestorRequests = useMemo(() => computeAncestorRequestRefs(ancestorIds, renderNodes), [ancestorIds, renderNodes])
  const ancestorLocalVariables = useMemo(() => computeAncestorLocalVariables(ancestorIds, renderNodes), [ancestorIds, renderNodes])
  const selectedRequest = selection?.kind === 'request' ? selection.request : selection?.kind === 'inlineRequest' ? selection.request : null
  const draftNodeIds = useMemo(() => Object.keys(requestDrafts).filter((id) => renderNodes.some((node) => node.id === id && (node.type === 'request' ? node.data.request !== null : isSimpleFlowNode(node) && node.data.config.kind === 'inlineRequest'))), [requestDrafts, renderNodes])
  const effectiveVariables = useMemo(() => mergeScopedVariables(environmentVariables, collections, selection?.kind === 'request' ? selection.requestId : null), [environmentVariables, collections, selection])
  const availableData = useMemo(() => {
    const values: FlowVariableDefinition[] = []
    const datasets: FlowDatasetSource[] = []
    for (const node of fromFlowNodes(nodes)) {
      if (!ancestorIds.has(node.id)) continue
      if (node.kind === 'setVariables') for (const assignment of node.assignments) values.push({ name: assignment.name, value: assignment.operation === 'set' ? assignment.value : undefined, source: t('flows.studio.local') })
      if (node.kind === 'load') {
        try {
          const settings = JSON.parse(node.config) as Record<string, unknown>
          if (node.loadKind === 'dataset' && typeof settings.assetId === 'string') datasets.push({ nodeId: node.id, label: node.label, assetId: settings.assetId })
          if (node.loadKind === 'extract' && typeof settings.name === 'string') values.push({ name: settings.name, source: node.label })
          if (node.loadKind === 'configureSession' && settings.variables && typeof settings.variables === 'object') for (const [name, value] of Object.entries(settings.variables)) values.push({ name, value: String(value), source: node.label })
          if ((node.loadKind === 'forEach' || node.loadKind === 'select') && typeof settings.variable === 'string') values.push({ name: settings.variable, source: node.label })
          if (node.loadKind === 'dataset' && Array.isArray(settings.rows) && settings.rows[0] && typeof settings.rows[0] === 'object') for (const [name, value] of Object.entries(settings.rows[0] as object)) values.push({ name, value: String(value), source: node.label })
        } catch { /* Invalid draft configuration is validated by the existing load preview. */ }
      }
    }
    return { definitions: values.filter((value) => value.name.trim()), datasets }
  }, [nodes, ancestorIds, t])
  const { definitions, datasets } = availableData
  const mappingTarget = renderNodes.find((node) => node.id === (mappingNodeId ?? selectedNodeId))
  const mappingAncestors = computeAncestorIds(mappingTarget?.id ?? '', edges)
  const mappingSources = computeAncestorRequestRefs(mappingAncestors, renderNodes)
  const mappingVariables = mergeScopedVariables(environmentVariables, collections, mappingTarget?.type === 'request' ? mappingTarget.data.requestId : null)
  const mappingDefinitions = [...computeAncestorLocalVariables(mappingAncestors, renderNodes), ...(mappingTarget?.id === selectedNodeId ? definitions.map((definition) => definition.name) : [])]
  const graphSignature = useMemo(() => JSON.stringify({ nodes: fromFlowNodes(nodes).map((node) => ({ ...node, position: undefined })), edges: fromFlowEdges(edges), requests: nodes.filter((node) => node.type === 'request').map((node) => findRequest(collections, (node.data as { requestId: string }).requestId)?.content), environmentVariables }), [nodes, edges, collections, environmentVariables])
  const beginRun = () => {
    pendingInitialAnswers.current = undefined
    if (draftNodeIds.length > 0) { setPendingRun(true); return }
    setExecutedSignature(graphSignature)
    handleRun()
  }
  const saveDrafts = async (ids: string[]) => {
    const updates = ids.flatMap((nodeId) => {
      const node = renderNodes.find((candidate) => candidate.id === nodeId)
      const request = node?.type === 'request' ? node.data.request : node && isSimpleFlowNode(node) && node.data.config.kind === 'inlineRequest' ? node.data.config.request : null
      return request && requestDrafts[nodeId] ? [{ nodeId, request: { ...request, content: requestDrafts[nodeId] }, inline: node?.type !== 'request' }] : []
    })
    const current = latestGraphRef.current
    const applyUpdates = (currentNodes: FlowNode[]) => currentNodes.map((node) => {
      const update = updates.find((candidate) => candidate.nodeId === node.id && candidate.inline)
      return update && isSimpleFlowNode(node) && node.data.config.kind === 'inlineRequest' ? { ...node, data: { ...node.data, config: { kind: 'inlineRequest' as const, request: update.request } } } : node
    })
    await onSaveRequestDrafts?.(updates, { nodes: fromFlowNodes(applyUpdates(current.nodes)), edges: fromFlowEdges(current.edges) })
    const next = applyUpdates(latestGraphRef.current.nodes)
    setNodes(next)
    onChange(fromFlowNodes(next), fromFlowEdges(latestGraphRef.current.edges))
  }
  useEffect(() => {
    if (!runAfterSave || draftNodeIds.length > 0) return
    const timer = window.setTimeout(() => {
      setRunAfterSave(false)
      setExecutedSignature(graphSignature)
      handleRun(pendingInitialAnswers.current)
      pendingInitialAnswers.current = undefined
    }, 0)
    return () => window.clearTimeout(timer)
  }, [runAfterSave, draftNodeIds, graphSignature, handleRun])

  useEffect(() => {
    pendingChangeRef.current = true
    const timeout = window.setTimeout(flushChange, 300)
    return () => window.clearTimeout(timeout)
  }, [nodes, edges, flushChange])

  // Flush before unmounting so switching tabs preserves edits from the final debounce interval.
  useEffect(() => flushChange, [flushChange])

  const appliedInlineMockRevisionRef = useRef(externalInlineMockServer?.revision)
  useEffect(() => {
    if (!externalInlineMockServer || externalInlineMockServer.revision === appliedInlineMockRevisionRef.current) return
    appliedInlineMockRevisionRef.current = externalInlineMockServer.revision
    const { nodeId, server } = externalInlineMockServer
    setConfigForNode(nodeId, { kind: 'mockStart', source: { type: 'inline', server } })
  }, [externalInlineMockServer, setConfigForNode])

  const appliedInlineRevisionRef = useRef(externalInlineRequest?.revision)
  useEffect(() => {
    if (!externalInlineRequest || externalInlineRequest.revision === appliedInlineRevisionRef.current) return
    appliedInlineRevisionRef.current = externalInlineRequest.revision
    const { nodeId, request } = externalInlineRequest
    setConfigForNode(nodeId, { kind: 'inlineRequest', request })
  }, [externalInlineRequest, setConfigForNode])

  // Create the chain at the drop point; connect Start only when it has no outgoing edge.
  const appliedChainRevisionRef = useRef(externalRequestChain?.revision)
  useEffect(() => {
    if (!externalRequestChain || externalRequestChain.revision === appliedChainRevisionRef.current) return
    appliedChainRevisionRef.current = externalRequestChain.revision
    const instance = reactFlowInstanceRef.current
    if (!instance) return
    const origin = instance.screenToFlowPosition(externalRequestChain.clientPoint)
    const { nodes: currentNodes, edges: currentEdges } = latestGraphRef.current
    const connectFrom = startWithoutOutput(fromFlowNodes(currentNodes), fromFlowEdges(currentEdges))
    const reserved = [...currentNodes.map((node) => ({ id: node.id }))]
    let index = 0
    const chain = buildRequestChain(externalRequestChain.requestIds, origin, connectFrom, () => {
      if (index >= externalRequestChain.requestIds.length) return crypto.randomUUID()
      const requestId = externalRequestChain.requestIds[index++]
      const id = availableNodeIdentifier(findRequest(collections, requestId)?.name ?? 'request', reserved)
      reserved.push({ id })
      return id
    })
    const occupied = flowLayoutModel(currentNodes, currentEdges).nodes.map((node) => ({ position: node.position, measured: { width: node.width, height: node.height } }))
    chain.nodes = chain.nodes.map((node) => {
      const position = availableNodePosition(node.position, occupied)
      occupied.push({ position, measured: flowNodeSize('request', 2) })
      return { ...node, position }
    })
    setNodes((current) => [...current, ...toFlowNodes(chain.nodes)])
    setEdges((current) => [...current, ...toFlowEdges(chain.edges)])
  }, [externalRequestChain, setNodes, setEdges, collections])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === connection.target) {
        showToast(t('flows.canvas.connectSelfLoopToast'), 'error')
        return
      }
      const alreadyExists = edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          edge.sourceHandle === connection.sourceHandle,
      )
      if (alreadyExists) {
        showToast(t('flows.canvas.connectDuplicateToast'), 'error')
        return
      }
      // Reject only loop bodies that this connection would open; existing invalid bodies are reported at execution.
      const whileIds = nodes.filter((node) => node.type === 'while').map((node) => node.id)
      if (whileIds.length > 0 && connection.source && connection.target) {
        const current = fromFlowEdges(edges)
        const candidate = [
          ...current,
          {
            id: 'candidate',
            sourceNodeId: connection.source,
            targetNodeId: connection.target,
            sourceHandle: isFlowSourceHandle(connection.sourceHandle) ? connection.sourceHandle : undefined,
          },
        ]
        const openBefore = whilesWithOpenBody(whileIds, current)
        const openAfter = whilesWithOpenBody(whileIds, candidate)
        if ([...openAfter].some((whileId) => !openBefore.has(whileId))) {
          showToast(t('flows.canvas.connectOpenLoopBodyToast'), 'error')
          return
        }
      }
      setEdges((current) => addEdge({ ...connection, markerEnd: edgeMarker(connection.sourceHandle) }, current))
    },
    [nodes, edges, setEdges, showToast, t],
  )

  // Releasing a connection on empty space opens the block palette; create the edge only after selection. Valid target handles use onConnect.
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
    if (connectionState.isValid || connectionState.toNode) return
    const { fromNode, fromHandle } = connectionState
    if (!fromNode || fromHandle?.type !== 'source') return
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    if (!point) return
    const instance = reactFlowInstanceRef.current
    if (!instance) return
    const sourceHandle = isFlowSourceHandle(fromHandle.id) ? fromHandle.id : undefined
    setPaletteTrigger({
      anchor: new DOMRect(point.clientX, point.clientY, 0, 0),
      sourceNodeId: fromNode.id,
      sourceHandle,
      dropPosition: instance.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
    })
  }, [])

  // The block-menu shortcut opens the palette at the pointer without creating an edge (spec 0088).
  const openPaletteAt = useCallback((clientX: number, clientY: number) => {
    const instance = reactFlowInstanceRef.current
    if (!instance) return
    setPaletteTrigger({
      anchor: new DOMRect(clientX, clientY, 0, 0),
      sourceNodeId: null,
      dropPosition: instance.screenToFlowPosition({ x: clientX, y: clientY }),
    })
  }, [])

  const isPaletteClick = useCallback(
    (event: ReactMouseEvent | MouseEvent) => isShortcutFor(shortcutBindings, 'openBlockPalette', comboFromMouseEvent(event)),
    [shortcutBindings],
  )

  // Left-click clears selection and closes the palette. A left-button palette shortcut opens only when no node is selected; React Flow deselects after this handler.
  const onPaneClick = useCallback(
    (event: ReactMouseEvent) => {
      const hadSelection = selectedNodeId !== null || nodes.some((node) => node.selected) || edges.some((edge) => edge.selected)
      setSelectedNodeId(null)
      if (!hadSelection && isPaletteClick(event)) {
        openPaletteAt(event.clientX, event.clientY)
        return
      }
      setPaletteTrigger(null)
    },
    [selectedNodeId, nodes, edges, isPaletteClick, openPaletteAt],
  )

  // Suppress the native context menu only when the click matches the configured shortcut.
  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      if (!isPaletteClick(event)) return
      event.preventDefault()
      openPaletteAt(event.clientX, event.clientY)
    },
    [isPaletteClick, openPaletteAt],
  )

  // Handle middle-button palette shortcuts through auxclick; right clicks are handled separately.
  const onCanvasAuxClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !(event.target instanceof Element) || !event.target.closest('.react-flow__pane')) return
    if (isPaletteClick(event)) {
      event.preventDefault()
      openPaletteAt(event.clientX, event.clientY)
    } else {
      setPaletteTrigger(null)
    }
  }

  // Open the palette at the pointer or canvas center, unless a text field or modal owns keyboard input.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (viewMode === 'panels' || event.defaultPrevented || event.isComposing || hasOpenModal() || isTextEntryTarget(event.target)) return
      if (!isShortcutFor(shortcutBindings, 'openBlockPalette', comboFromEvent(event))) return
      const bounds = containerRef.current?.getBoundingClientRect()
      if (!bounds) return
      event.preventDefault()
      const pointer = lastPointerRef.current
      const pointerInside =
        pointer !== null && pointer.x >= bounds.left && pointer.x <= bounds.right && pointer.y >= bounds.top && pointer.y <= bounds.bottom
      const point = pointerInside ? pointer : { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      openPaletteAt(point.x, point.y)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [shortcutBindings, openPaletteAt, viewMode])

  // Close the screen-anchored palette on canvas movement; programmatic movement such as fitView has no originating event.
  const onMove = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) setPaletteTrigger(null)
  }, [])

  const handleLabelChange = useCallback(
    (nodeId: string, label: string) => {
      setNodes((current) =>
        current.map((node) => (node.id === nodeId && node.type === 'block' ? { ...node, data: { ...node.data, label } } : node)),
      )
    },
    [setNodes],
  )

  const renameGraphNodeInEditor = (previous: string, next: string) => {
    if (!nodes.some((node) => node.id === previous) || standardRun.isRunning || loadRun.isRunning || requestSaving || savingDrafts || identifierError(next, previous, nodes)) throw new Error('The node cannot be renamed in its current state.')
    changePresentation({ panels: presentation.panels.map((panel) => panel.nodeId === previous ? { ...panel, nodeId: next } : panel) })
    const graph = renameGraphNode(fromFlowNodes(nodes), fromFlowEdges(edges), previous, next)
    onRenameNode?.(previous, next)
    for (const node of renderNodes) {
      if (node.type !== 'request' || !node.data.request) continue
      const request = node.data.request
      const content = requestDrafts[node.id] ?? request.content
      const updated = renameNodeReferences(content, previous, next)
      if (JSON.stringify(content) !== JSON.stringify(updated)) onRequestDraftChange?.(node.id === previous ? next : node.id, request, updated, false)
    }
    setNodes(toFlowNodes(graph.nodes))
    setEdges(toFlowEdges(graph.edges))
    setSelectedNodeId(next)
    setMappingNodeId(next)
    setSnapshotNodeIds((current) => { const updated = { ...current, [next]: current[previous] ?? previous }; delete updated[previous]; return updated })
    setDisplayFormats((current) => { const updated = { ...current, [next]: current[previous] ?? 'auto' }; delete updated[previous]; try { localStorage.setItem(`alcy:flows:${flow.id}:display-formats`, JSON.stringify(updated)) } catch { /* Keep presentation preferences in memory. */ } return updated })
    onChange(graph.nodes, graph.edges)
  }

  const renameNode = (next: string) => { if (selectedNodeId) renameGraphNodeInEditor(selectedNodeId, next) }

  useAgentResourceController(agentBridge, 'flow', flow.id, {
    read: () => dtoFromFlow({ ...flow, nodes: fromFlowNodes(latestGraphRef.current.nodes), edges: fromFlowEdges(latestGraphRef.current.edges), presentation }),
    replace: (dto) => {
      if (isRunning || requestSaving || savingDrafts) throw new Error('The flow is busy.')
      const next = flowFromDto(dto)
      pendingChangeRef.current = false
      setNodes(toFlowNodes(next.nodes))
      setEdges(toFlowEdges(next.edges))
      if (next.presentation) setPresentation(next.presentation)
    },
    renameNode: renameGraphNodeInEditor,
    status: () => ({ flowExecutionId, isRunning, statuses, error: standardRun.error, awaitingInput: initialFormOpen || pendingRun, load: isLoadFlow ? { runId: loadRun.runId, isRunning: loadRun.isRunning, progress: loadRun.progress, detail: loadRun.detail, error: loadRun.error } : undefined }),
    run: async () => {
      if (isRunning || requestSaving || savingDrafts || loadingLoadPreview) throw new Error('The flow is busy.')
      if (isLoadFlow) {
        if (!loadTestingEnabled) throw new Error('Load testing is disabled.')
        if (draftNodeIds.length > 0) throw new Error('Save or discard request drafts before executing a load flow.')
        flushChange()
        await onPrepareLoadRun?.()
        const result = await previewLoadFlow(rootPath, flow.id)
        if (!result.ok) throw new Error(result.error.kind === 'notFound' ? 'Flow not found.' : result.error.message)
        const runId = loadRun.start()
        return { flowId: flow.id, runId, status: 'starting', preview: result.value }
      }
      if (draftNodeIds.length > 0 || fromFlowNodes(nodes).some((node) => node.kind === 'start' && node.form)) {
        beginRun()
        return { flowId: flow.id, status: 'awaitingInput' }
      }
      await onPrepareRun?.()
      return { flowId: flow.id, flowExecutionId: run(), status: 'starting' }
    },
    cancel,
  })

  // Place toolbar-created nodes near the visible canvas center using screenToFlowPosition with screen coordinates.
  const newNodePosition = (): { x: number; y: number } => {
    const instance = reactFlowInstanceRef.current
    const bounds = containerRef.current?.querySelector('.react-flow')?.getBoundingClientRect()
    if (!instance || !bounds) return { x: 260, y: 0 }
    return instance.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
  }

  // Honor explicit drop positions. Otherwise place nodes to the right of their source with a branch offset, or at the visible center.
  const positionForNewNode = (sourceNodeId: string | null, sourceHandle?: FlowSourceHandle): { x: number; y: number } => {
    if (paletteTrigger?.dropPosition) return availableNodePosition(paletteTrigger.dropPosition, nodes)
    if (sourceNodeId) {
      const source = nodes.find((node) => node.id === sourceNodeId)
      if (source) {
        const sourceHeight = source.measured?.height ?? 128
        const yOffset = branchOrder(sourceHandle) * (sourceHeight + G.rowGap)
        return availableNodePosition({ x: source.position.x + (source.measured?.width ?? (source.type === 'start' ? G.compactWidth : G.width)) + G.columnGap, y: source.position.y + yOffset }, nodes)
      }
    }
    return availableNodePosition(newNodePosition(), nodes)
  }

  const closePalette = () => setPaletteTrigger(null)

  // Preserve the named source output when creating an edge from a released connection.
  const addAutoEdge = (sourceNodeId: string, targetNodeId: string) => {
    setEdges((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle: paletteTrigger?.sourceHandle,
        markerEnd: edgeMarker(paletteTrigger?.sourceHandle),
      },
    ])
  }

  // Notes remain unconnected even when created from a handle.
  const handlePaletteSelectSimple = (config: SimpleNodeKindState) => {
    const sourceNodeId = config.kind === 'note' ? null : (paletteTrigger?.sourceNodeId ?? null)
    const newId = availableNodeIdentifier(config.kind === 'inlineRequest' ? config.request.name : config.kind, nodes)
    const position = positionForNewNode(paletteTrigger?.sourceNodeId ?? null, paletteTrigger?.sourceHandle)
    setNodes((current) => [...current, simpleFlowNode(newId, position, config)])
    if (sourceNodeId) addAutoEdge(sourceNodeId, newId)
    closePalette()
  }

  const handlePaletteSelect = (kind: PaletteKind) => {
    if (isLoadFlow && EXECUTABLE_LOAD_NODE_KINDS.includes(kind as LoadNodeKindState)) handlePaletteSelectLoad(kind as LoadNodeKindState)
    else if (kind === 'if') handlePaletteSelectIf()
    else if (kind === 'request') handlePaletteSelectRequest()
    else if (kind === 'inlineRequest') handlePaletteSelectSimple(newInlineRequest(t('flows.canvas.newInlineRequestName')))
    else if (isSimpleNodeKind(kind)) {
      const config = defaultSimpleNodeConfig(kind)
      // New mock blocks inherit the source's Start mock reference, or the flow's sole Start mock.
      const sourceNodeId = paletteTrigger?.sourceNodeId ?? null
      const sourceConfig = simpleConfigs.find((node) => node.id === sourceNodeId)?.config
      const inherited = sourceConfig && 'startNodeId' in sourceConfig ? sourceConfig.startNodeId : sourceNodeId
      handlePaletteSelectSimple('startNodeId' in config ? { ...config, startNodeId: defaultMockStartNodeId(inherited, mockStarts) } : config)
    }
  }

  const handlePaletteSelectLoad = (loadKind: LoadNodeKindState) => {
    const sourceNodeId = paletteTrigger?.sourceNodeId ?? null
    const newId = availableNodeIdentifier(loadKind, nodes)
    setNodes((current) => [...current, {
      id: newId,
      type: 'block',
      position: positionForNewNode(sourceNodeId, paletteTrigger?.sourceHandle),
      data: {
        label: defaultLoadNodeLabel(loadKind, t),
        loadKind,
        loadConfig: defaultLoadNodeConfig(loadKind),
        onOpenSettings: () => {}, onDelete: () => {}, onDuplicate: () => {},
      },
    }])
    if (sourceNodeId) addAutoEdge(sourceNodeId, newId)
    closePalette()
  }

  const handlePaletteSelectIf = () => {
    const sourceNodeId = paletteTrigger?.sourceNodeId ?? null
    const newId = availableNodeIdentifier('if', nodes)
    setNodes((current) => [
      ...current,
      {
        id: newId,
        type: 'if',
        position: positionForNewNode(sourceNodeId, paletteTrigger?.sourceHandle),
        data: { condition: DEFAULT_CONDITION, runStatus: { status: 'idle' }, onOpenSettings: () => {}, onDelete: () => {}, onDuplicate: () => {} },
      },
    ])
    if (sourceNodeId) addAutoEdge(sourceNodeId, newId)
    closePalette()
  }

  const handlePaletteSelectRequest = () => {
    const sourceNodeId = paletteTrigger?.sourceNodeId ?? null
    const newId = availableNodeIdentifier('request', nodes)
    setNodes((current) => [
      ...current,
      {
        id: newId,
        type: 'request',
        position: positionForNewNode(sourceNodeId, paletteTrigger?.sourceHandle),
        data: {
          requestId: '',
          request: null,
          runStatus: { status: 'idle' },
          collections: [],
          environmentVariables: [],
          onSelectRequest: () => {},
          onOpenSettings: () => {},
          onDelete: () => {},
          onDuplicate: () => {},
        },
      },
    ])
    if (sourceNodeId) addAutoEdge(sourceNodeId, newId)
    closePalette()
  }

  const initialStart = fromFlowNodes(nodes).find((node) => node.kind === 'start')
  const initialForm = initialStart?.kind === 'start' ? initialStart.form : null
  const waitingNodes = standardRun.runNodes.filter((node) => node.kind === 'humanAction' && statuses[node.id]?.status === 'waitingForHuman')
  function renderHumanForm(nodeId: string) {
    const node = standardRun.runNodes.find((node) => node.id === nodeId)
    const status = statuses[nodeId]
    if (node?.kind !== 'humanAction' || status?.status !== 'waitingForHuman' || !status.waitId || !flowExecutionId) return <p className="flow-form-description">{status?.status === 'failed' ? status.message : describeRunStatus(status ?? { status: 'idle' }, t)?.label ?? t('flows.panels.idle')}</p>
    const request = { flowExecutionId, nodeId, waitId: status.waitId }
    const answers = standardRun.formDrafts[status.waitId] ?? initialFormAnswers(node.form)
    return <FlowFormView key={status.waitId} form={node.form} request={request} answers={answers} onChange={(values) => standardRun.setFormDrafts((drafts) => ({ ...drafts, [request.waitId]: values }))} onSubmit={async () => { await submitFlowForm(request, answers); setHumanFormNodeId(null) }} />
  }
  function renderInitialForm() {
    if (!initialForm) return null
    const answers = standardRun.formDrafts.initial ?? initialFormAnswers(initialForm)
    return <FlowFormView form={initialForm} answers={answers} disabled={isRunning || loadingLoadPreview || requestSaving} submitLabel={t('flows.canvas.runButtonLabel')} onChange={(values) => standardRun.setFormDrafts((drafts) => ({ ...drafts, initial: values }))} onSubmit={async () => {
      if (draftNodeIds.length > 0) { pendingInitialAnswers.current = answers; setInitialFormOpen(false); setPendingRun(true); return }
      setExecutedSignature(graphSignature)
      handleRun(answers)
    }} />
  }
  function renderPanelContent(node: FlowNodeState) {
    if (node.kind === 'start') return renderInitialForm()
    if (node.kind === 'humanAction') return renderHumanForm(node.id)
    if (node.kind !== 'display') return null
    const status = statuses[node.id]
    if (status?.status !== 'completed') return <p className="flow-form-description">{status?.status === 'failed' ? status.message : describeRunStatus(status ?? { status: 'idle' }, t)?.label ?? t('flows.panels.idle')}</p>
    const sourceId = displayBodyNodeId(node.template)
    return <DisplayOutput value={status.message ?? ''} format={displayFormats[node.id] ?? 'auto'} source={sourceId && flowExecutionId ? { rootPath, flowExecutionId, nodeId: snapshotNodeIds[sourceId] ?? sourceId, version: outputVersions[sourceId] ?? 0 } : undefined} />
  }

  return (
    <FlowMappingProvider rootPath={rootPath} flowExecutionId={flowExecutionId} onTargetNodeChange={setMappingNodeId} scopeKey={mappingNodeId ?? selectedNodeId ?? ''} sources={mappingSources.filter((source) => source.output !== 'mockServer').map((source) => ({ nodeId: source.nodeId, snapshotNodeId: snapshotNodeIds[source.nodeId], label: source.label, scope: source.output === 'mockRequest' ? 'request' : 'response' }))} references={[...mappingVariables.map((variable) => `{{${variable.name}}}`), ...mappingDefinitions.map((name) => `{{${name}}}`), ...mappingSources.flatMap((source) => source.output === 'mockServer' ? [`{{nodes.${source.nodeId}.server.url}}`] : (source.output === 'mockRequest' ? ['request.body', 'request.method', 'request.path'] : ['response.body', 'response.status', 'response.headers']).map((path) => `{{nodes.${source.nodeId}.${path}}}`))]} onInsert={() => setInspectorTab('configuration')}><div className="flow-canvas-shell flow-studio" style={flowGeometryStyle}>
    {!isLoadFlow && <div className="flow-mode-toolbar">
      <FlowTabs items={[{ id: 'diagram', label: t('flows.panels.diagram') }, { id: 'panels', label: t('flows.panels.panels') }]} value={viewMode} onChange={setViewMode} label={t('flows.panels.panels')} />
      {viewMode === 'panels' && <div className="flow-mode-toolbar-actions"><Button variant="ghost" size="sm" onClick={() => setLogOpen((value) => !value)}>{t('flows.runLog.title')}</Button><Button variant={isRunning ? 'danger' : 'primary'} disabled={loadingLoadPreview || (!isRunning && requestSaving)} onClick={isRunning ? cancel : beginRun}>{isRunning ? t('common.cancel') : t('flows.canvas.runButtonLabel')}</Button></div>}
    </div>}
    {waitingNodes.length > 0 && <div className="flow-human-notice" role="status"><span>{t('flows.forms.pending')}</span>{waitingNodes.map((node) => <Button variant="ghost" size="sm" key={node.id} onClick={() => setHumanFormNodeId(node.id)}>{node.kind === 'humanAction' && node.form.title || node.id} · {t('flows.forms.open')}</Button>)}</div>}
    <div
      className="flow-canvas"
      style={{ display: viewMode === 'panels' ? 'none' : undefined }}
      ref={containerRef}
      data-drop-id={flow.id}
      data-drop-kind="flow"
      onMouseMove={(event) => {
        lastPointerRef.current = { x: event.clientX, y: event.clientY }
      }}
      onMouseLeave={() => {
        lastPointerRef.current = null
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.matches('.react-flow__node')) {
          const id = event.target.dataset.id
          if (id) { event.preventDefault(); setSelectedNodeId(id); setMappingNodeId(id); setInspectorTab('configuration') }
        }
      }}
      onAuxClick={onCanvasAuxClick}
    >
      <ReactFlow
        nodes={renderNodes}
        edges={renderEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        onNodesChange={onNodesChange}
        onNodeDoubleClick={(_event, node) => { setSelectedNodeId(node.id); setMappingNodeId(node.id); setInspectorTab('configuration') }}
        onNodeClick={(_event, node) => { setSelectedNodeId(node.id); setMappingNodeId(node.id); setInspectorTab('configuration') }}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onMove={onMove}
        onMoveEnd={(_event, viewport) => snapViewportToWholePixels(reactFlowInstanceRef.current, viewport)}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onInit={(instance) => {
          reactFlowInstanceRef.current = instance
        }}
        fitView
        snapToGrid
        snapGrid={[G.grid, G.grid]}
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={G.grid} size={1} />
        <Controls showInteractive={false} />

        <Panel position="top-left" className="flow-canvas-panel">
          <button
            type="button"
            className="ui-button ui-button--ghost ui-button--sm flow-add-menu-button"
            // Stop mousedown before the palette's outside-click listener so toggling this button cannot close and reopen the palette in one gesture.
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              const anchor = event.currentTarget.getBoundingClientRect()
              setPaletteTrigger((current) => (current && current.sourceNodeId === null ? null : { anchor, sourceNodeId: null }))
            }}
          >
            <PlusIcon size={13} />
            <span>{t('flows.canvas.addBlocksMenuLabel')}</span>
          </button>
          <Button variant="ghost" size="sm" onClick={organization.organizing ? organization.cancel : organization.organize} disabled={nodes.every((node) => node.type === 'note')}>{t(organization.organizing ? 'flows.canvas.cancelOrganization' : 'flows.canvas.organize')}</Button>
        </Panel>

        <Panel position="top-right" className="flow-canvas-run-actions">
          {!logOpen && logEntries.length > 0 && (
            <Button variant="ghost" onClick={() => setLogOpen(true)} aria-label={t('flows.runLog.showAria')}>
              {t('flows.runLog.title')}
            </Button>
          )}
          <Button variant={isRunning ? 'danger' : 'primary'} onClick={isRunning ? cancel : beginRun} aria-busy={isRunning || loadingLoadPreview} disabled={loadingLoadPreview || (!isRunning && requestSaving) || (isLoadFlow && !loadTestingEnabled)}>
            {(isRunning || loadingLoadPreview) && <Spinner size={13} />}
            {isRunning ? t('common.cancel') : t('flows.canvas.runButtonLabel')}
          </Button>
        </Panel>

        {isLoadFlow && isRunning && (
          <Panel position="bottom-left" className="flow-canvas-load-progress" aria-live="polite">
            <strong>{t('flows.loadRun.running')}</strong>
            <span>{t('flows.loadRun.vus', { active: String(loadRun.progress.activeVus), planned: String(loadRun.progress.plannedVus) })}</span>
            <span>{t('flows.loadRun.requests')}: {loadRun.progress.requests}</span>
            <span>{t('flows.loadRun.errors')}: {loadRun.progress.failedRequests}</span>
          </Panel>
        )}

        <Panel position="bottom-right" className="flow-canvas-experimental-badge">
          <Badge tone="accent">{t('flows.canvas.experimentalBadge')}</Badge>
        </Panel>
      </ReactFlow>

      {paletteTrigger && (
        <BlockPalette
          anchor={paletteTrigger.anchor}
          executionKind={flow.executionKind}
          onClose={closePalette}
          onSelect={handlePaletteSelect}
        />
      )}

      {selection && (
        <NodeInspectorPanel
          onStartFormChange={(id, form) => setNodes((nodes) => nodes.map((node) => node.id === id && node.type === 'start' ? { ...node, data: { ...node.data, form } } : node))}
          humanForm={selection.kind === 'humanAction' ? renderHumanForm(selection.id) : undefined}
          snapshotNodeIds={snapshotNodeIds}
          nodeIdentifiers={nodes}
          onRenameNode={onRenameNode ? renameNode : undefined}
          renameDisabled={standardRun.isRunning || loadRun.isRunning || requestSaving || savingDrafts}
          outputVersions={outputVersions}
          flowId={flow.id}
          datasets={datasets}
          rootPath={rootPath}
          flowExecutionId={flowExecutionId}
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          nodeStatus={statuses[snapshotNodeIds[selection.id] ?? selection.id]}
          load={isLoadFlow}
          definitions={definitions}
          outdated={executedSignature !== null && executedSignature !== graphSignature}
          displayFormat={displayFormats[selection.id] ?? 'auto'}
          onDisplayFormatChange={(format) => setDisplayFormat(selection.id, format)}
          requestEditor={selectedRequest && onRequestDraftChange ? <FlowRequestEditor key={selection.kind === 'request' ? selectedRequest.id : selection.id} rootPath={rootPath} content={requestDrafts[selection.id] ?? selectedRequest.content} variables={effectiveVariables} dirty={Boolean(requestDrafts[selection.id])} busy={requestSaving} targetLabel={selection.kind === 'request' ? t('flows.studio.saveTargetLinked', { path: findRequestPath(collections, selectedRequest.id)?.join(' / ') ?? selectedRequest.name }) : t('flows.studio.saveTargetInline')} onChange={(content) => onRequestDraftChange(selection.id, selectedRequest, content, selection.kind !== 'request')} onSave={() => saveDrafts([selection.id])} onDiscard={() => onDiscardRequestDrafts?.([selection.id])} /> : undefined}
          selection={selection}
          ancestorRequests={ancestorRequests}
          ancestorLocalVariables={ancestorLocalVariables}
          environmentVariables={effectiveVariables}
          collections={collections}
          onLabelChange={handleLabelChange}
          onConditionChange={setConditionForNode}
          onRequestChange={setRequestForNode}
          onConfigChange={setConfigForNode}
          onLoadConfigChange={setLoadConfigForNode}
          onImportDatasetAsset={importDatasetAsset}
          onEditInlineRequest={editInlineRequest}
          mockStartOptions={Object.values(mockStarts).filter((start) => ancestorIds.has(start.nodeId))}
          selectedMockStart={selectedMockStart(selection, mockStarts)}
          savedMockServers={flowMockServers.summaries}
          onEditInlineMockServer={editInlineMockServer}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
      {loadPreview && (
        <Modal title={t('flows.loadRun.confirmTitle')} closeAriaLabel={t('flows.loadRun.confirmCloseAria')} onClose={() => setLoadPreview(null)} onEnter={() => { setLoadPreview(null); loadRun.start() }} className="ui-modal--form">
          {(requestClose) => (
            <>
              <p className="ui-modal-description">{t('flows.loadRun.confirmDescription')}</p>
              <dl className="load-run-confirmation-summary">
                <div><dt>{t('flows.loadRun.peakVus')}</dt><dd>{loadPreview.peakVus}</dd></div>
                <div><dt>{t('flows.loadRun.duration')}</dt><dd>{loadPreview.durationMs === null ? t('flows.loadRun.durationOpen') : `${loadPreview.durationMs} ms`}</dd></div>
                {loadPreview.peakArrivalRatePerSecond !== null && <div><dt>{t('flows.loadRun.peakRate')}</dt><dd>{loadPreview.peakArrivalRatePerSecond.toFixed(2)} {t('flows.loadRun.requestsPerSecond')}</dd></div>}
              </dl>
              <h3>{t('flows.loadRun.destinations')}</h3>
              <ul className="load-run-confirmation-list">{loadPreview.destinations.map((destination) => <li key={destination}>{destination}</li>)}</ul>
              <h3>{t('flows.loadRun.scenarios')}</h3>
              <ul className="load-run-confirmation-list">{loadPreview.scenarios.map((scenario) => <li key={scenario.nodeId}>{scenario.label} · {scenario.peakVus} VUs{scenario.peakArrivalRatePerSecond === null ? '' : ` · ${scenario.peakArrivalRatePerSecond.toFixed(2)} ${t('flows.loadRun.requestsPerSecond')}`} · {scenario.requestCount} {t('flows.loadRun.requests').toLocaleLowerCase()}</li>)}</ul>
              <div className="ui-modal-actions">
                <Button variant="ghost" onClick={requestClose}>{t('common.cancel')}</Button>
                <Button variant="primary" onClick={() => { setLoadPreview(null); loadRun.start() }}>{t('flows.loadRun.confirmButton')}</Button>
              </div>
            </>
          )}
        </Modal>
      )}
      {pendingRun && <Modal title={t('flows.studio.runPendingTitle')} closeAriaLabel={t('common.close')} onClose={() => setPendingRun(false)} className="ui-modal--form">
        <p className="ui-modal-description">{t('flows.studio.runPendingDescription')}</p><div className="ui-modal-actions"><Button variant="ghost" disabled={savingDrafts} onClick={() => setPendingRun(false)}>{t('common.cancel')}</Button><Button variant="ghost" disabled={savingDrafts} onClick={() => { onDiscardRequestDrafts?.(draftNodeIds); setPendingRun(false); setRunAfterSave(true) }}>{t('flows.studio.discardAndRun')}</Button><Button variant="primary" disabled={savingDrafts} aria-busy={savingDrafts} onClick={() => { setSavingDrafts(true); void saveDrafts(draftNodeIds).then(() => { setPendingRun(false); setRunAfterSave(true) }).catch((reason: unknown) => showToast(t('flows.canvas.runErrorToast', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')).finally(() => setSavingDrafts(false)) }}>{t('flows.studio.saveAndRun')}</Button></div>
      </Modal>}
    </div>
    {viewMode === 'panels' && <FlowPanels nodes={fromFlowNodes(nodes)} presentation={presentation} onChange={changePresentation} statuses={statuses} renderContent={renderPanelContent} />}
    {initialFormOpen && initialForm && <Modal title={t('flows.forms.start')} closeAriaLabel={t('common.cancel')} onClose={() => setInitialFormOpen(false)} className="ui-modal--form flow-form-modal">{renderInitialForm()}</Modal>}
    {humanFormNodeId && waitingNodes.some((node) => node.id === humanFormNodeId) && <Modal key={humanFormNodeId} title={t('flows.forms.humanAction')} closeAriaLabel={t('common.cancel')} onClose={() => setHumanFormNodeId(null)} className="ui-modal--form flow-form-modal">{renderHumanForm(humanFormNodeId)}</Modal>}
    {logOpen && (
      <RunLogPanel
        rootPath={rootPath}
        onSelectNode={(nodeId) => { const currentId = Object.entries(snapshotNodeIds).find(([, snapshotId]) => snapshotId === nodeId)?.[0] ?? nodeId; setSelectedNodeId(currentId); setMappingNodeId(currentId); setInspectorTab('output'); void reactFlowInstanceRef.current?.fitView({ nodes: [{ id: currentId }], maxZoom: 1, duration: 200 }) }}
        key={runStartedAtMs ?? 0}
        entries={logEntries}
        nodeInfo={runLogNodeInfo}
        runStartedAtMs={runStartedAtMs}
        flowExecutionId={flowExecutionId}
        isRunning={standardRun.isRunning}
        onClose={() => setLogOpen(false)}
      />
    )}
    {loadRun.detail && <LoadRunResults key={loadRun.detail.id} rootPath={rootPath} detail={loadRun.detail} onClose={() => loadRun.setDetail(null)} />}
    </div></FlowMappingProvider>
  )
}
