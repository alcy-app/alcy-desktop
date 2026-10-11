import { useCallback, useEffect, useRef, useState } from 'react'
import { moveById } from '../environments/reorder'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import { listFlows } from '../../bindings/list-flows'
import type { FlowDto } from '../../bindings/list-flows'
import { saveFlows } from '../../bindings/save-flows'
import { useLanguage } from '../../shared/i18n/use-language'
import { requestFromDto, requestToDto } from '../request-workbench/use-collections-state'
import { isFlowSourceHandle, isSimpleNode, simpleNodeConfig } from './flows.types'
import type { FlowEdgeState, FlowNodeState, FlowState, SimpleNodeKindState } from './flows.types'
import { buildRequestChain } from './request-chain'
import type { RequestSummary } from '../request-workbench/collection-tree'
import { defaultLoadNodeConfig } from './load-node-config'
import type { MockServerDto } from '../../bindings/mock-servers'

const SAVE_DEBOUNCE_MS = 500
export const START_NODE_ID = 'start'

export function flowNodeFromDto(node: FlowDto['nodes'][number]): FlowNodeState {
  // Antes de `isSimpleNode`: no DTO a requisição tem outro formato.
  if (node.kind === 'inlineRequest') {
    return { id: node.id, kind: 'inlineRequest', request: requestFromDto(node.request), position: { x: node.x, y: node.y } }
  }
  if (isSimpleNode(node)) {
    return { id: node.id, ...simpleNodeConfig(node), position: { x: node.x, y: node.y } }
  }
  if (node.kind === 'start') {
    return { id: node.id, kind: 'start', position: { x: node.x, y: node.y } }
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
    // `inlineRequest` já saiu acima; o estreitamento só não chega até `simpleNodeConfig`.
    const config = simpleNodeConfig(node) as Exclude<SimpleNodeKindState, { kind: 'inlineRequest' }>
    return { id: node.id, ...config, x: node.position.x, y: node.position.y }
  }
  if (node.kind === 'start') {
    return { id: node.id, kind: 'start', x: node.position.x, y: node.position.y }
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
  // A migração canônica (edge sem handle saindo de um `request` vira
  // "success") é a de `flow_store.rs`; isto só impede que um estado inválido
  // em memória seja rejeitado em silêncio pelo `save_flows`.
  const requestNodeIds = new Set(dto.nodes.filter((node) => node.kind === 'request').map((node) => node.id))
  return {
    id: dto.id,
    name: dto.name,
    executionKind: dto.executionKind,
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
    nodes: flow.nodes.map(dtoFromFlowNode),
    edges: flow.edges.map(dtoFromEdge),
    createdAtMs: flow.createdAtMs,
    updatedAtMs: flow.updatedAtMs,
  }
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

/** Flow de carga mínimo, pronto para configurar e executar pelo canvas. */
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
      { id: scenarioId, kind: 'load', loadKind: 'scenario', label: labels.scenario, config: defaultLoadNodeConfig('scenario'), position: { x: 300, y: 0 } },
      { id: requestId, kind: 'load', loadKind: 'request', label: labels.request, config: defaultLoadNodeConfig('request'), position: { x: 660, y: -70 } },
    ],
    edges: [
      { id: crypto.randomUUID(), sourceNodeId: START_NODE_ID, targetNodeId: scenarioId },
      { id: crypto.randomUUID(), sourceNodeId: scenarioId, targetNodeId: requestId, sourceHandle: 'iteration' },
    ],
  }
}

/** Flow novo com as requisições encadeadas a partir do Start (spec 0095). */
export function createFlowFromRequests(name: string, requestIds: string[]): FlowState {
  const flow = createFlow(name)
  const chain = buildRequestChain(requestIds, { x: 360, y: 0 }, START_NODE_ID)
  return { ...flow, nodes: [...flow.nodes, ...chain.nodes], edges: chain.edges }
}

export function useFlowsState(workspaceRootPath: string, onSaved?: () => void) {
  const { t } = useLanguage()
  const [flows, setFlows] = useState<FlowState[]>([])
  const [loaded, setLoaded] = useState(false)
  // Arquivo que não foi lido (ex.: gravado por uma versão mais nova do app): enquanto houver erro,
  // nada é salvo, para não trocar o conteúdo do disco pelo estado vazio mostrado na tela.
  const [loadError, setLoadError] = useState<string | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const flowsRef = useRef(flows)
  const [reloadToken, setReloadToken] = useState(0)
  // O efeito de salvar reage a `flows`/`loaded` juntos — sem isso, o próprio carregamento (que
  // muda os dois no mesmo render) dispararia um save supérfluo, reescrevendo o arquivo no disco
  // sem nenhuma edição real (o que já bastava para acender "modificado" indevidamente).
  const skipNextSaveRef = useRef(false)

  useEffect(() => {
    flowsRef.current = flows
  }, [flows])

  /** Relê o arquivo do disco (ex.: depois de uma atualização do repositório remoto), descartando um save pendente que o sobrescreveria. */
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
      void saveFlows(workspaceRootPath, { flows: flows.map(dtoFromFlow) }).then(() => onSaved?.())
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [flows, loaded, loadError, workspaceRootPath, onSaved])

  const addFlow = useCallback(() => {
    const flow = createFlow(t('flows.newFlowName'))
    setFlows((current) => [...current, flow])
    return flow.id
  }, [t])

  const addFlowFromRequests = useCallback((name: string, requestIds: string[]) => {
    const flow = createFlowFromRequests(name, requestIds)
    setFlows((current) => [...current, flow])
    return flow.id
  }, [])

  const addLoadFlow = useCallback(() => {
    const flow = createLoadFlow(t('flows.newLoadFlowName'), {
      scenario: t('flows.loadNode.scenario.label'),
      request: t('flows.loadNode.request.label'),
    })
    setFlows((current) => [...current, flow])
    return flow.id
  }, [t])

  /** O backend já persistiu a importação e devolveu seu flow canônico. A
   * inclusão no estado evita esperar o próximo reload do workspace. */
  const addImportedFlow = useCallback((dto: FlowDto) => {
    const flow = flowFromDto(dto)
    setFlows((current) => [...current.filter((candidate) => candidate.id !== flow.id), flow])
    return flow.id
  }, [])

  /** Reordena a lista de flows (arraste). A ordem é a do arquivo salvo. */
  const moveFlow = useCallback((draggedId: string, targetId: string, edge: SiblingEdge) => {
    setFlows((current) => moveById(current, draggedId, targetId, edge))
  }, [])

  const removeFlow = useCallback((id: string) => {
    setFlows((current) => current.filter((flow) => flow.id !== id))
  }, [])

  const renameFlow = useCallback((id: string, name: string) => {
    setFlows((current) =>
      current.map((flow) => (flow.id === id ? { ...flow, name, updatedAtMs: Date.now() } : flow)),
    )
  }, [])

  /** Grava a requisição de um node avulso (salvar na aba do workbench). `false`
   * quando o node não existe mais. */
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

  /** Grava o mock avulso de um bloco "Ligar mock" (salvar na aba do
   * workbench). `false` quando o node não existe mais ou deixou de ser avulso. */
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

  const updateFlowGraph = useCallback((id: string, nodes: FlowNodeState[], edges: FlowEdgeState[]) => {
    setFlows((current) =>
      current.map((flow) => (flow.id === id ? { ...flow, nodes, edges, updatedAtMs: Date.now() } : flow)),
    )
  }, [])

  /** Cancela o debounce e persiste a versão mais recente antes de um command
   * que relê o flow do disco. Retorna o erro ao chamador para que a execução
   * jamais use um plano anterior sem avisar a pessoa. */
  const saveNow = useCallback(async () => {
    if (!loaded) return
    if (loadError !== null) throw new Error(loadError)
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    const result = await saveFlows(workspaceRootPath, { flows: flowsRef.current.map(dtoFromFlow) })
    if (!result.ok) throw new Error(result.error.message)
    onSaved?.()
  }, [loaded, loadError, onSaved, workspaceRootPath])

  return {
    flows,
    loadError,
    loaded,
    reload,
    addFlow,
    addLoadFlow,
    addFlowFromRequests,
    addImportedFlow,
    removeFlow,
    moveFlow,
    renameFlow,
    saveNow,
    updateFlowGraph,
    updateInlineMockServer,
    updateInlineRequest,
  }
}
