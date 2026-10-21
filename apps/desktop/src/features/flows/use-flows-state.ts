import { useCallback, useEffect, useRef, useState } from 'react'
import { moveById } from '../environments/reorder'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import { listFlows } from '../../bindings/list-flows'
import type { FlowDto, FlowFolderDto } from '../../bindings/list-flows'
import { saveFlows } from '../../bindings/save-flows'
import { useLanguage } from '../../shared/i18n/use-language'
import { requestFromDto, requestToDto } from '../request-workbench/use-collections-state'
import { isFlowSourceHandle, isSimpleNode, simpleNodeConfig } from './flows.types'
import type { FlowEdgeState, FlowNodeState, FlowState, SimpleNodeKindState } from './flows.types'
import { buildRequestChain } from './request-chain'
import { FLOW_GEOMETRY as G } from './flow-geometry'
import type { RequestSummary } from '../request-workbench/collection-tree'
import { defaultLoadNodeConfig } from './load-node-config'
import type { MockServerDto } from '../../bindings/mock-servers'
import { createFlowFromTemplate, type FlowTemplateId } from './flow-templates'

const SAVE_DEBOUNCE_MS = 500
export const START_NODE_ID = 'start'

export function flowNodeFromDto(node: FlowDto['nodes'][number]): FlowNodeState {
  // Handle inline requests before generic simple nodes because their DTO has a different request representation.
  if (node.kind === 'inlineRequest') {
    return { id: node.id, kind: 'inlineRequest', request: requestFromDto(node.request), position: { x: node.x, y: node.y } }
  }
  if (isSimpleNode(node)) {
    return { id: node.id, ...simpleNodeConfig(node), position: { x: node.x, y: node.y } }
  }
  if (node.kind === 'start') {
    return { id: node.id, kind: 'start', ...(node.form ? { form: node.form } : {}), position: { x: node.x, y: node.y } }
  }
  if (node.kind === 'request') {
    return { id: node.id, kind: 'request', requestId: node.requestId, position: { x: node.x, y: node.y } }
  }
  if (node.kind === 'if') {
    return { id: node.id, kind: 'if', condition: node.condition, position: { x: node.x, y: node.y } }
  }
  if (node.kind === 'load') {
    return { id: node.id, kind: 'load', loadKind: node.loadKind, label: node.label, config: node.config, position: { x: node.x, y: node.y } }
  }
  return { id: node.id, kind: 'block', label: node.label, position: { x: node.x, y: node.y } }
}

export function dtoFromFlowNode(node: FlowNodeState): FlowDto['nodes'][number] {
  if (node.kind === 'inlineRequest') {
    return { id: node.id, kind: 'inlineRequest', request: requestToDto(node.request), x: node.position.x, y: node.position.y }
  }
  if (isSimpleNode(node)) {
    // Inline requests were handled above; explicitly narrow the remaining simple-node union.
    const config = simpleNodeConfig(node) as Exclude<SimpleNodeKindState, { kind: 'inlineRequest' }>
    return { id: node.id, ...config, x: node.position.x, y: node.position.y }
  }
  if (node.kind === 'start') {
    return { id: node.id, kind: 'start', ...(node.form ? { form: node.form } : {}), x: node.position.x, y: node.position.y }
  }
  if (node.kind === 'request') {
    return { id: node.id, kind: 'request', requestId: node.requestId, x: node.position.x, y: node.position.y }
  }
  if (node.kind === 'if') {
    return { id: node.id, kind: 'if', condition: node.condition, x: node.position.x, y: node.position.y }
  }
  if (node.kind === 'load') {
    return { id: node.id, kind: 'load', loadKind: node.loadKind, label: node.label, config: node.config, x: node.position.x, y: node.position.y }
  }
  return { id: node.id, kind: 'block', label: node.label, x: node.position.x, y: node.position.y }
}

export function edgeFromDto(edge: FlowDto['edges'][number]): FlowEdgeState {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    sourceHandle: isFlowSourceHandle(edge.sourceHandle) ? edge.sourceHandle : undefined,
  }
}

function dtoFromEdge(edge: FlowEdgeState): FlowDto['edges'][number] {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    sourceHandle: edge.sourceHandle,
  }
}

function flowFromDto(dto: FlowDto): FlowState {
  // Match flow_store.rs migration of unnamed request outputs to success so valid in-memory edges are not silently rejected during persistence.
  const requestNodeIds = new Set(dto.nodes.filter((node) => node.kind === 'request').map((node) => node.id))
  return {
    id: dto.id,
    name: dto.name,
    executionKind: dto.executionKind,
    presentation: dto.presentation,
    nodes: dto.nodes.map(flowNodeFromDto),
    edges: dto.edges.map((edge) => {
      const state = edgeFromDto(edge)
      return state.sourceHandle === undefined && requestNodeIds.has(state.sourceNodeId)
        ? { ...state, sourceHandle: 'success' as const }
        : state
    }),
    createdAtMs: dto.createdAtMs,
    updatedAtMs: dto.updatedAtMs,
  }
}

function dtoFromFlow(flow: FlowState): FlowDto {
  return {
    id: flow.id,
    name: flow.name,
    executionKind: flow.executionKind,
    presentation: flow.presentation,
    nodes: flow.nodes.map(dtoFromFlowNode),
    edges: flow.edges.map(dtoFromEdge),
    createdAtMs: flow.createdAtMs,
    updatedAtMs: flow.updatedAtMs,
  }
}

function presentationForNodes(flow: FlowState, nodes: FlowNodeState[]) {
  if (!flow.presentation) return undefined
  const eligible = new Set(nodes.filter((node) => node.kind === 'display' || node.kind === 'humanAction' || (node.kind === 'start' && node.form)).map((node) => node.id))
  return { panels: flow.presentation.panels.filter((panel) => eligible.has(panel.nodeId)) }
}

function createFlow(name: string): FlowState {
  const now = Date.now()
  const startNode: FlowNodeState = { id: START_NODE_ID, kind: 'start', position: { x: 0, y: 0 } }
  return { id: crypto.randomUUID(), name, executionKind: 'standard', nodes: [startNode], edges: [], createdAtMs: now, updatedAtMs: now }
}

interface LoadFlowStarterLabels {
  scenario: string
  request: string
}

/** Minimal executable load flow, ready for configuration in the canvas. */
export function createLoadFlow(
  name: string,
  labels: LoadFlowStarterLabels = { scenario: 'Cenário', request: 'Request' },
): FlowState {
  const flow = createFlow(name)
  const scenarioId = crypto.randomUUID()
  const requestId = crypto.randomUUID()
  return {
    ...flow,
    executionKind: 'load',
    nodes: [
      ...flow.nodes,
      { id: scenarioId, kind: 'load', loadKind: 'scenario', label: labels.scenario, config: defaultLoadNodeConfig('scenario'), position: { x: G.compactWidth + G.columnGap, y: 0 } },
      { id: requestId, kind: 'load', loadKind: 'request', label: labels.request, config: defaultLoadNodeConfig('request'), position: { x: G.compactWidth + G.width + G.columnGap * 2, y: 0 } },
    ],
    edges: [
      { id: crypto.randomUUID(), sourceNodeId: START_NODE_ID, targetNodeId: scenarioId },
      { id: crypto.randomUUID(), sourceNodeId: scenarioId, targetNodeId: requestId, sourceHandle: 'iteration' },
    ],
  }
}

/** Create a flow that chains the selected requests after Start (spec 0095). */
export function createFlowFromRequests(name: string, requestIds: string[]): FlowState {
  const flow = createFlow(name)
  const chain = buildRequestChain(requestIds, { x: G.compactWidth + G.columnGap, y: 0 }, START_NODE_ID)
  return { ...flow, nodes: [...flow.nodes, ...chain.nodes], edges: chain.edges }
}

export function useFlowsState(workspaceRootPath: string, onSaved?: () => void) {
  const { t } = useLanguage()
  const [flows, setFlows] = useState<FlowState[]>([])
  const [folders, setFolders] = useState<FlowFolderDto[]>([])
  const foldersRef = useRef(folders)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Do not save after a failed load; an empty UI must never overwrite an unreadable or newer file.
  const [loadError, setLoadError] = useState<string | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const flowsRef = useRef(flows)
  const [reloadToken, setReloadToken] = useState(0)
  // Loading flows and the loaded flag together must not trigger a redundant write or falsely mark the file modified.
  const skipNextSaveRef = useRef(false)

  useEffect(() => {
    flowsRef.current = flows
    foldersRef.current = folders
  }, [flows, folders])

  /** Reload from disk and cancel pending saves that could overwrite externally updated content. */
  const reload = useCallback(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    skipNextSaveRef.current = true

    void listFlows(workspaceRootPath).then((result) => {
      if (cancelled) return

      if (result.ok) {
        setFlows(result.value.flows.map(flowFromDto))
        setFolders(result.value.folders ?? [])
        setSaveError(null)
      }

      setLoadError(result.ok ? null : result.error.message)
      setLoaded(true)
    })

    return () => {
      cancelled = true
    }
  }, [workspaceRootPath, reloadToken])

  useEffect(() => {
    if (!loaded || loadError !== null) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }

    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      void saveFlows(workspaceRootPath, { flows: flows.map(dtoFromFlow), folders }).then((result) => {
        setSaveError(result.ok ? null : result.error.message)
        if (result.ok) onSaved?.()
      })
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [flows, folders, loaded, loadError, workspaceRootPath, onSaved])

  const addFlow = useCallback((folderId?: string) => {
    const flow = createFlow(t('flows.newFlowName'))
    setFlows((current) => [...current, flow])
    if (folderId) setFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, flowIds: [...folder.flowIds, flow.id] } : folder))
    return flow.id
  }, [t])

  const addFlowFromRequests = useCallback((name: string, requestIds: string[]) => {
    const flow = createFlowFromRequests(name, requestIds)
    setFlows((current) => [...current, flow])
    return flow.id
  }, [])

  const addFlowFromTemplate = useCallback((templateId: FlowTemplateId, folderId?: string) => {
    const flow = createFlowFromTemplate(templateId, t)
    setFlows((current) => [...current, flow])
    if (folderId) setFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, flowIds: [...folder.flowIds, flow.id] } : folder))
    return flow.id
  }, [t])

  const addLoadFlow = useCallback((folderId?: string) => {
    const flow = createLoadFlow(t('flows.newLoadFlowName'), {
      scenario: t('flows.loadNode.scenario.label'),
      request: t('flows.loadNode.request.label'),
    })
    setFlows((current) => [...current, flow])
    if (folderId) setFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, flowIds: [...folder.flowIds, flow.id] } : folder))
    return flow.id
  }, [t])

  /** The backend already persisted the imported graph; add its canonical result without waiting for workspace reload. */
  const addImportedFlow = useCallback((dto: FlowDto) => {
    const flow = flowFromDto(dto)
    setFlows((current) => [...current.filter((candidate) => candidate.id !== flow.id), flow])
    return flow.id
  }, [])

  /** Reorder flows by drag; the persisted array determines display order. */
  const moveFlow = useCallback((draggedId: string, targetId: string, edge: SiblingEdge) => {
    setFlows((current) => moveById(current, draggedId, targetId, edge))
    setFolders((current) => {
      const targetFolderId = current.find((folder) => folder.flowIds.includes(targetId))?.id
      return current.map((folder) => ({
        ...folder,
        flowIds: folder.id === targetFolderId
          ? [...folder.flowIds.filter((id) => id !== draggedId), draggedId]
          : folder.flowIds.filter((id) => id !== draggedId),
      }))
    })
  }, [])

  const removeFlow = useCallback((id: string) => {
    setFlows((current) => current.filter((flow) => flow.id !== id))
    setFolders((current) => current.map((folder) => ({ ...folder, flowIds: folder.flowIds.filter((flowId) => flowId !== id) })))
  }, [])

  const addFolder = useCallback(() => {
    const folder = { id: crypto.randomUUID(), name: t('flows.newFolderName'), flowIds: [] }
    setFolders((current) => [...current, folder])
    return folder.id
  }, [t])

  const renameFolder = useCallback((id: string, name: string) => {
    if (!name.trim()) return
    setFolders((current) => current.map((folder) => folder.id === id ? { ...folder, name } : folder))
  }, [])

  const removeFolder = useCallback((id: string) => {
    setFolders((current) => current.filter((folder) => folder.id !== id))
  }, [])

  const moveFolder = useCallback((id: string, targetId: string, edge: SiblingEdge) => {
    setFolders((current) => moveById(current, id, targetId, edge))
  }, [])

  const moveFlowToFolder = useCallback((flowId: string, folderId: string | null) => {
    setFolders((current) => {
      if (folderId !== null && !current.some((folder) => folder.id === folderId)) return current
      return current.map((folder) => ({
        ...folder,
        flowIds: folder.id === folderId
          ? [...folder.flowIds.filter((id) => id !== flowId), flowId]
          : folder.flowIds.filter((id) => id !== flowId),
      }))
    })
  }, [])

  const renameFlow = useCallback((id: string, name: string) => {
    setFlows((current) =>
      current.map((flow) => (flow.id === id ? { ...flow, name, updatedAtMs: Date.now() } : flow)),
    )
  }, [])

  /** Save an inline node request from its workbench tab; return false if the node was removed. */
  const updateInlineRequest = useCallback(
    (flowId: string, nodeId: string, request: RequestSummary): boolean => {
      const exists = flows.some(
        (flow) => flow.id === flowId && flow.nodes.some((node) => node.id === nodeId && node.kind === 'inlineRequest'),
      )
      if (!exists) return false
      setFlows((current) =>
        current.map((flow) =>
          flow.id === flowId
            ? {
                ...flow,
                nodes: flow.nodes.map((node) => (node.id === nodeId && node.kind === 'inlineRequest' ? { ...node, request } : node)),
                updatedAtMs: Date.now(),
              }
            : flow,
        ),
      )
      return true
    },
    [flows],
  )

  /** Save an inline Start mock from its workbench tab; return false if the node was removed or changed source kind. */
  const updateInlineMockServer = useCallback(
    (flowId: string, nodeId: string, server: MockServerDto): boolean => {
      const isInlineMock = (node: FlowNodeState) => node.id === nodeId && node.kind === 'mockStart' && node.source.type === 'inline'
      if (!flows.some((flow) => flow.id === flowId && flow.nodes.some(isInlineMock))) return false
      setFlows((current) =>
        current.map((flow) =>
          flow.id === flowId
            ? {
                ...flow,
                nodes: flow.nodes.map((node) => (isInlineMock(node) ? { ...node, source: { type: 'inline', server } } : node)),
                updatedAtMs: Date.now(),
              }
            : flow,
        ),
      )
      return true
    },
    [flows],
  )

  const updatePresentation = useCallback((id: string, presentation: import('../../bindings/flow-forms').FlowPresentation) => {
    setFlows((current) => current.map((flow) => flow.id === id ? { ...flow, presentation, updatedAtMs: Date.now() } : flow))
  }, [])

  const updateFlowGraph = useCallback((id: string, nodes: FlowNodeState[], edges: FlowEdgeState[]) => {
    setFlows((current) =>
      current.map((flow) => (flow.id === id ? { ...flow, nodes, edges, presentation: presentationForNodes(flow, nodes), updatedAtMs: Date.now() } : flow)),
    )
  }, [])

  /** Flush the latest graph before native commands read it; propagate persistence failures so execution cannot silently use an older plan. */
  const saveNow = useCallback(async () => {
    if (!loaded) return
    if (loadError !== null) throw new Error(loadError)
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    const result = await saveFlows(workspaceRootPath, { flows: flowsRef.current.map(dtoFromFlow), folders: foldersRef.current })
    if (!result.ok) throw new Error(result.error.message)
    setSaveError(null)
    onSaved?.()
  }, [loaded, loadError, onSaved, workspaceRootPath])

  /** Explicit node-request saves finish on disk before their shared draft is marked saved. */
  const saveGraph = useCallback(async (id: string, nodes: FlowNodeState[], edges: FlowEdgeState[]) => {
    if (!loaded || loadError !== null) throw new Error(loadError ?? 'Flows are not loaded')
    const next = flowsRef.current.map((flow) => flow.id === id ? { ...flow, nodes, edges, presentation: presentationForNodes(flow, nodes), updatedAtMs: Date.now() } : flow)
    if (!next.some((flow) => flow.id === id)) throw new Error('Flow no longer exists')
    if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = null
    const result = await saveFlows(workspaceRootPath, { flows: next.map(dtoFromFlow), folders: foldersRef.current })
    if (!result.ok) throw new Error(result.error.message)
    setFlows(next)
    onSaved?.()
  }, [loaded, loadError, onSaved, workspaceRootPath])

  return {
    flows,
    folders,
    saveError,
    addFolder,
    renameFolder,
    removeFolder,
    moveFolder,
    moveFlowToFolder,
    loadError,
    loaded,
    reload,
    addFlow,
    addLoadFlow,
    addFlowFromRequests,
    addFlowFromTemplate,
    addImportedFlow,
    removeFlow,
    moveFlow,
    renameFlow,
    saveNow,
    saveGraph,
    updateFlowGraph,
    updatePresentation,
    updateInlineMockServer,
    updateInlineRequest,
  }
}
