import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ScopedVariableChange } from '../../bindings/execute-graphql-request'
import { addEdge, Background, BackgroundVariant, Controls, Panel, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react'
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
import { findRequest, requestMethodLabel } from '../request-workbench/collection-tree'
import type { RequestSummary, TreeNode } from '../request-workbench/collection-tree'
import { BlockPalette } from './BlockPalette'
import type { PaletteKind } from './BlockPalette'
import type { FlowEdgeType } from './flow-edge-types'
import { isFlowSourceHandle, isSimpleNodeKind } from './flows.types'
import type { ConditionState, FlowEdgeState, FlowNodeState, FlowSourceHandle, FlowState, LoadNodeKindState, SimpleNodeKindState } from './flows.types'
import { RunLogPanel } from './RunLogPanel'
import type { RunLogNodeInfo } from './RunLogPanel'
import { NodeInspectorPanel } from './NodeInspectorPanel'
import type { AncestorRequestRef, InspectorSelection } from './NodeInspectorPanel'
import { edgeMarker, isSimpleFlowNode, snapViewportToWholePixels, toFlowEdges, toFlowNodes } from './flow-canvas-mapping'
import type { FlowNode } from './flow-canvas-mapping'
import { edgeTypes, nodeTypes } from './flow-node-types'
import { buildRequestChain, startWithoutOutput } from './request-chain'
import { isVisitedStatus } from './flow-run-trail'
import { whilesWithOpenBody } from './loop-body'
import { configOfSimpleNode, defaultSimpleNodeConfig, newInlineRequest, simpleFlowNode, simpleNodeLogInfo } from './simple-node-types'
import { useFlowRun } from './use-flow-run'
import { LoadRunResults } from './LoadRunResults'
import { useLoadFlowRun } from './use-load-flow-run'
import { EXECUTABLE_LOAD_NODE_KINDS, defaultLoadNodeConfig, defaultLoadNodeLabel } from './load-node-config'
import { defaultMockStartNodeId, findMockRoute, mockRouteLabel, resolveMockStarts, savedMockServerIds } from './mock-nodes'
import type { MockStartInfo } from './mock-nodes'
import { useFlowMockServers } from './use-flow-mock-servers'
import './flow-canvas.css'


const DEFAULT_CONDITION: ConditionState = { left: '', operator: 'equals', right: '' }

function fromFlowNodes(nodes: FlowNode[]): FlowNodeState[] {
  return nodes.map((node): FlowNodeState => {
    if (isSimpleFlowNode(node)) {
      return { id: node.id, ...configOfSimpleNode(node), position: node.position }
    }
    if (node.type === 'start') {
      return { id: node.id, kind: 'start', position: node.position }
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

/** BFS reversa sobre as edges atuais — espelha, só para exibição, o conceito
 * de `ancestors` que já existe no backend (`crates/alcy-app/src/flow_graph.rs`).
 * A validação real de "é mesmo um ancestral" continua só no motor de execução. */
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

/** Referências `{{nodes.<id>...}}` disponíveis: só nodes `request` ancestrais. */
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

/** Variáveis locais (`{{nome}}`) definidas por nodes `setVariables` ancestrais. */
function computeAncestorLocalVariables(ancestorIds: Set<string>, nodes: FlowNode[]): string[] {
  const names = new Set<string>()
  for (const node of nodes) {
    if (!ancestorIds.has(node.id) || !isSimpleFlowNode(node) || node.data.config.kind !== 'setVariables') continue
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

/** Mock de um bloco de mock no canvas (spec 0121): o do próprio "Ligar mock"
 * ou o do bloco para onde os demais apontam. */
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

/** Foco num campo de digitação — ali a tecla é do campo, não do atalho do canvas. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type)
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

interface PaletteTrigger {
  anchor: DOMRect
  /** `null` quando disparado pela toolbar ou pelo atalho no vazio do canvas (sem edge automática); presente quando disparado ao soltar uma conexão em espaço vazio do canvas. */
  sourceNodeId: string | null
  /** Só presente quando a conexão saiu de uma das saídas nomeadas de um node `if` ou `request` — qual delas a edge automática deve carregar. */
  sourceHandle?: FlowSourceHandle
  /** Posição (em coordenadas do flow) onde a conexão foi solta ou o atalho foi acionado — onde o novo node nasce. */
  dropPosition?: { x: number; y: number }
}

interface FlowCanvasProps {
  flow: FlowState
  collections: TreeNode[]
  onChange: (nodes: FlowNodeState[], edges: FlowEdgeState[]) => void
  rootPath: string
  environmentVariables: EnvironmentVariableDto[]
  onEnvironmentChanges?: (changes: { name: string; value: string | null }[]) => void
  onScopedChanges?: (changes: ScopedVariableChange[]) => void
  /** Chamado quando um run termina — o backend já gravou o histórico. */
  onRunFinished?: () => void
  /** Persiste o canvas antes de o preview/executor reler o flow por ID. */
  onPrepareLoadRun?: () => Promise<void>
  /** Recurso experimental controlado pelo workbench. Sem a flag, um flow de
   * carga persistido não pode disparar o executor pelo canvas. */
  loadTestingEnabled?: boolean
  /** Abre a requisição de um node avulso numa aba do workbench (spec 0086). */
  onEditInlineRequest?: (nodeId: string, request: RequestSummary) => void
  /** Requisição avulsa salva pela aba do workbench enquanto este canvas está
   * montado — aplicada no node quando `revision` muda, para que o próximo
   * `onChange` não a sobrescreva com a versão antiga. */
  externalInlineRequest?: { nodeId: string; request: RequestSummary; revision: number }
  /** Abre o mock avulso de um bloco "Ligar mock" numa aba do workbench (spec 0121). */
  onEditInlineMockServer?: (nodeId: string, server: MockServerDto) => void
  /** Mock avulso salvo pela aba do workbench — mesmo mecanismo de
   * `externalInlineRequest`. */
  externalInlineMockServer?: { nodeId: string; server: MockServerDto; revision: number }
  /** Requisições de um item da árvore largado sobre este canvas (spec 0095),
   * com o ponto de soltura em coordenadas de tela — aplicadas quando
   * `revision` muda. */
  externalRequestChain?: { requestIds: string[]; clientPoint: { x: number; y: number }; revision: number }
}

/** Canvas de um flow (ADR 0013 para a lib de canvas; motor de execução na
 * spec 0043, ligado à UI aqui): criação/edição/persistência de nodes e
 * edges, e Run/Cancel sobre o grafo atual via `useFlowRun`. Espera ser
 * montado com `key={flow.id}` pelo chamador (`RequestWorkbench`), já que
 * `useNodesState`/`useEdgesState` só leem o valor inicial uma vez — trocar
 * de flow precisa de uma instância nova, não de sincronizar props depois da
 * montagem. */
export function FlowCanvas({
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
}: FlowCanvasProps) {
  const { t } = useLanguage()
  const { bindings: shortcutBindings } = useShortcuts()
  const { showToast } = useToast()
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(toFlowNodes(flow.nodes))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(flow.edges))
  const [paletteTrigger, setPaletteTrigger] = useState<PaletteTrigger | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [loadPreview, setLoadPreview] = useState<LoadFlowPreviewDto | null>(null)
  const [loadingLoadPreview, setLoadingLoadPreview] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const reactFlowInstanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdgeType> | null>(null)

  // Blocos de mock (spec 0121): cada um enxerga o mock do "Ligar mock" a que se refere.
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

  const standardRun = useFlowRun({
    rootPath,
    flowName: flow.name,
    onRunFinished,
    onEnvironmentChanges,
    onScopedChanges,
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
  const { statuses, traversedEdges, logEntries, runStartedAtMs, flowExecutionId, run } = standardRun

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

  // `deleteElements` (não filtrar `nodes`/`edges` na mão) porque já resolve
  // corretamente as duas regras que o motor de arrastar/editar já depende:
  // respeita `deletable: false` (o node `Start` nunca é removido por aqui) e
  // remove em cascata as edges conectadas ao node.
  const deleteNode = useCallback((nodeId: string) => {
    void reactFlowInstanceRef.current?.deleteElements({ nodes: [{ id: nodeId }] })
  }, [])

  // Duplica um node `block`/`request` a partir do estado bruto (não de
  // `renderNodes`), já que é a fonte da verdade — a cópia nasce deslocada
  // e desconectada (sem clonar edges), como qualquer node novo adicionado
  // pela paleta. `Start` nunca duplica (não passa por aqui: nenhum dos dois
  // node components chama isso).
  const duplicateNode = useCallback((nodeId: string) => {
    setNodes((current) => {
      const source = current.find((node) => node.id === nodeId)
      if (!source) return current
      const newId = crypto.randomUUID()
      const position = { x: source.position.x + 40, y: source.position.y + 40 }
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

  // Chamado pelo `RequestPicker` (dentro do node ou do inspector) quando o
  // usuário escolhe uma requisição: node recém-criado ainda vazio, correção de
  // uma referência quebrada ou troca deliberada — só grava o `requestId`, a resolução em `request` continua
  // acontecendo ao vivo em `renderNodes`.
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

  // Chamado pelo `NodeInspectorPanel` ao editar a condição de um node `if`.
  const setConditionForNode = useCallback(
    (nodeId: string, condition: ConditionState) => {
      setNodes((current) =>
        current.map((node) => (node.id === nodeId && node.type === 'if' ? { ...node, data: { ...node.data, condition } } : node)),
      )
    },
    [setNodes],
  )

  // Configuração de um node simples (spec 0083) — inspector ou edição direta
  // no node (texto da anotação).
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

  // Abre a requisição avulsa no workbench com o conteúdo atual do node.
  const editInlineRequest = useCallback(
    (nodeId: string) => {
      const node = latestGraphRef.current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || !isSimpleFlowNode(node) || node.data.config.kind !== 'inlineRequest') return
      flushChange()
      onEditInlineRequest?.(nodeId, node.data.config.request)
    },
    [flushChange, onEditInlineRequest],
  )

  // Abre o mock avulso no workbench com o conteúdo atual do node.
  const editInlineMockServer = useCallback(
    (nodeId: string) => {
      const node = latestGraphRef.current.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || !isSimpleFlowNode(node) || node.data.config.kind !== 'mockStart' || node.data.config.source.type !== 'inline') return
      flushChange()
      onEditInlineMockServer?.(nodeId, node.data.config.source.server)
    },
    [flushChange, onEditInlineMockServer],
  )

  // `nodes` guarda só `requestId` para nodes de requisição; a referência é
  // resolvida ao vivo aqui (não uma cópia estática) para refletir
  // renomeações/edições feitas na coleção depois que o node foi criado.
  // `onNodesChange`/drag continuam operando sobre `nodes` (a fonte da
  // verdade), não sobre este array derivado. Status de execução só faz
  // sentido em nodes de requisição/if — Start/Block nunca rodam de fato.
  const renderNodes = useMemo<FlowNode[]>(
    () =>
      nodes.map((node): FlowNode => {
        const onDelete = () => deleteNode(node.id)
        const onOpenSettings = () => setSelectedNodeId(node.id)
        const onDuplicate = () => duplicateNode(node.id)
        const visited = node.type === 'start' ? traversedEdges.size > 0 : isVisitedStatus(statuses[node.id])
        if (isSimpleFlowNode(node)) {
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
        return { ...node, data: { visited } }
      }),
    [
      nodes,
      collections,
      environmentVariables,
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

  const handleRun = useCallback(() => {
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
    setLogOpen(true)
    run()
  }, [flow.executionKind, flow.id, loadTestingEnabled, onPrepareLoadRun, rootPath, run, showToast, t])

  const removeEdge = useCallback(
    (edgeId: string) => {
      setEdges((current) => current.filter((edge) => edge.id !== edgeId))
    },
    [setEdges],
  )

  // Uma edge é "ativa" enquanto o node de destino está rodando de verdade —
  // é o traço que representa a etapa em andamento durante um Run (só nodes
  // `request` chegam a `running`; Start/Block nunca aparecem aqui).
  const renderEdges = useMemo<FlowEdgeType[]>(
    () =>
      edges.map((edge) => ({
        ...edge,
        data: {
          onDelete: () => removeEdge(edge.id),
          active: statuses[edge.target]?.status === 'running',
          traversed: traversedEdges.has(edge.id),
          hovered: edge.id === hoveredEdgeId,
        },
      })),
    [edges, statuses, traversedEdges, hoveredEdgeId, removeEdge],
  )

  // Hover detectado pelo próprio xyflow (`pointer-events` na `<g>` da edge),
  // não por um path invisível manual — ver comentário em `FlowEdge.tsx`.
  const onEdgeMouseEnter = useCallback((_event: ReactMouseEvent, edge: FlowEdgeType) => setHoveredEdgeId(edge.id), [])
  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), [])

  const selection = useMemo<InspectorSelection | null>(() => {
    if (!selectedNodeId) return null
    const node = renderNodes.find((current) => current.id === selectedNodeId)
    if (!node) return null
    if (isSimpleFlowNode(node)) return { id: node.id, ...configOfSimpleNode(node) }
    if (node.type === 'start') return { id: node.id, kind: 'start' }
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

  useEffect(() => {
    pendingChangeRef.current = true
    const timeout = window.setTimeout(flushChange, 300)
    return () => window.clearTimeout(timeout)
  }, [nodes, edges, flushChange])

  // O canvas desmonta ao trocar de aba (ex.: abrir a requisição avulsa no
  // workbench) — sem isto, uma edição dos últimos 300 ms se perderia.
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

  // Cadeia nasce no ponto do drop; liga ao Start só se ele ainda não tem saída.
  const appliedChainRevisionRef = useRef(externalRequestChain?.revision)
  useEffect(() => {
    if (!externalRequestChain || externalRequestChain.revision === appliedChainRevisionRef.current) return
    appliedChainRevisionRef.current = externalRequestChain.revision
    const instance = reactFlowInstanceRef.current
    if (!instance) return
    const origin = instance.screenToFlowPosition(externalRequestChain.clientPoint)
    const { nodes: currentNodes, edges: currentEdges } = latestGraphRef.current
    const connectFrom = startWithoutOutput(fromFlowNodes(currentNodes), fromFlowEdges(currentEdges))
    const chain = buildRequestChain(externalRequestChain.requestIds, origin, connectFrom)
    setNodes((current) => [...current, ...toFlowNodes(chain.nodes)])
    setEdges((current) => [...current, ...toFlowEdges(chain.edges)])
  }, [externalRequestChain, setNodes, setEdges])

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
      // Recusa só o que esta conexão abriria — um corpo já aberto (ex.: edge
      // removida) não bloqueia outras edições; o run aponta o problema.
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

  // Conexão arrastada de um handle de saída e solta em espaço vazio (não
  // sobre outro node/handle) abre a paleta ali mesmo; a edge e o node só são
  // criados quando um bloco é escolhido. Soltar sobre um handle válido já é
  // tratado por `onConnect`.
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

  // Menu de blocos pelo atalho "Abrir menu de blocos" (spec 0088; padrão:
  // botão direito num ponto vazio). O bloco escolhido nasce no ponto, sem edge.
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

  // Clique esquerdo no vazio: limpa a seleção e fecha a paleta. Se o atalho
  // estiver no botão esquerdo, abre a paleta — mas, com algo selecionado, o
  // clique só limpa a seleção (o xyflow desmarca logo depois deste handler,
  // então `selected` ainda reflete o estado antes do clique).
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

  // Botão direito no vazio: o menu de contexto nativo só é suprimido quando
  // o clique é o atalho.
  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      if (!isPaletteClick(event)) return
      event.preventDefault()
      openPaletteAt(event.clientX, event.clientY)
    },
    [isPaletteClick, openPaletteAt],
  )

  // Botão do meio no vazio — o xyflow não expõe esse clique no pane. O
  // `auxclick` também chega para o botão direito, já tratado acima.
  const onCanvasAuxClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !(event.target instanceof Element) || !event.target.closest('.react-flow__pane')) return
    if (isPaletteClick(event)) {
      event.preventDefault()
      openPaletteAt(event.clientX, event.clientY)
    } else {
      setPaletteTrigger(null)
    }
  }

  // Atalho de teclado: abre a paleta sob o cursor, se ele estiver sobre o
  // canvas, ou no centro dele. Não age com o foco num campo de texto nem por
  // trás de um modal.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || hasOpenModal() || isTextEntryTarget(event.target)) return
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
  }, [shortcutBindings, openPaletteAt])

  // Arrastar ou dar zoom no canvas fecha a paleta: ela fica presa à tela, e o
  // ponto onde o bloco nasceria sairia de baixo dela. `event` é `null` em
  // movimentos programáticos (ex.: `fitView`).
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

  // Novo node nasce perto do centro visível do canvas (não mais num offset
  // fixo empilhado) — `screenToFlowPosition` espera coordenadas de tela
  // (client), por isso o centro vem do próprio container, não do viewport
  // interno do xyflow.
  const newNodePosition = (): { x: number; y: number } => {
    const instance = reactFlowInstanceRef.current
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!instance || !bounds) return { x: 260, y: 0 }
    return instance.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
  }

  // Disparado ao soltar uma conexão em espaço vazio: nasce onde o usuário
  // soltou. Sem `dropPosition` (toolbar), nasce no centro visível do canvas.
  // Se houver um node de origem sem posição de soltura, cai à direita dele,
  // deslocado por ramo (`sourceHandle`) para não empilhar os dois ramos.
  const positionForNewNode = (sourceNodeId: string | null, sourceHandle?: FlowSourceHandle): { x: number; y: number } => {
    if (paletteTrigger?.dropPosition) return paletteTrigger.dropPosition
    if (sourceNodeId) {
      const source = nodes.find((node) => node.id === sourceNodeId)
      if (source) {
        const yOffset = sourceHandle === 'true' || sourceHandle === 'success' || sourceHandle === 'loop' ? -110 : sourceHandle ? 110 : 0
        return { x: source.position.x + 360, y: source.position.y + yOffset }
      }
    }
    return newNodePosition()
  }

  const closePalette = () => setPaletteTrigger(null)

  // Edge automática da conexão solta no canvas: carrega `sourceHandle` quando
  // veio de uma saída nomeada de um node `if`/`request` — `undefined` para
  // todo outro node de saída única.
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

  // Anotação nunca se conecta: mesmo aberta a partir de um handle, nasce solta.
  const handlePaletteSelectSimple = (config: SimpleNodeKindState) => {
    const sourceNodeId = config.kind === 'note' ? null : (paletteTrigger?.sourceNodeId ?? null)
    const newId = crypto.randomUUID()
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
      // Um bloco de mock novo já aponta para o "Ligar mock" de onde saiu — ou
      // para o mesmo do bloco de mock de onde saiu, ou para o único do flow.
      const sourceNodeId = paletteTrigger?.sourceNodeId ?? null
      const sourceConfig = simpleConfigs.find((node) => node.id === sourceNodeId)?.config
      const inherited = sourceConfig && 'startNodeId' in sourceConfig ? sourceConfig.startNodeId : sourceNodeId
      handlePaletteSelectSimple('startNodeId' in config ? { ...config, startNodeId: defaultMockStartNodeId(inherited, mockStarts) } : config)
    }
  }

  const handlePaletteSelectLoad = (loadKind: LoadNodeKindState) => {
    const sourceNodeId = paletteTrigger?.sourceNodeId ?? null
    const newId = crypto.randomUUID()
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
    const newId = crypto.randomUUID()
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
    const newId = crypto.randomUUID()
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

  return (
    <div className="flow-canvas-shell">
    <div
      className="flow-canvas"
      ref={containerRef}
      data-drop-id={flow.id}
      data-drop-kind="flow"
      onMouseMove={(event) => {
        lastPointerRef.current = { x: event.clientX, y: event.clientY }
      }}
      onMouseLeave={() => {
        lastPointerRef.current = null
      }}
      onAuxClick={onCanvasAuxClick}
    >
      <ReactFlow
        nodes={renderNodes}
        edges={renderEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
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
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
        <Controls showInteractive={false} />

        <Panel position="top-left" className="flow-canvas-panel">
          <button
            type="button"
            className="ui-button ui-button--ghost ui-button--sm flow-add-menu-button"
            // Evita que o mousedown chegue ao listener de "clique fora" do
            // BlockPalette (mesmo padrão de `stopPropagation` no mousedown) — sem
            // isso, clicar de novo neste botão fecharia (outside click) e
            // reabriria (este onClick) no mesmo gesto, nunca fechando de
            // fato por um segundo clique.
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              const anchor = event.currentTarget.getBoundingClientRect()
              setPaletteTrigger((current) => (current && current.sourceNodeId === null ? null : { anchor, sourceNodeId: null }))
            }}
          >
            <PlusIcon size={13} />
            <span>{t('flows.canvas.addBlocksMenuLabel')}</span>
          </button>
        </Panel>

        <Panel position="top-right" className="flow-canvas-run-actions">
          {!logOpen && logEntries.length > 0 && (
            <Button variant="ghost" onClick={() => setLogOpen(true)} aria-label={t('flows.runLog.showAria')}>
              {t('flows.runLog.title')}
            </Button>
          )}
          <Button variant={isRunning ? 'danger' : 'primary'} onClick={isRunning ? cancel : handleRun} aria-busy={isRunning || loadingLoadPreview} disabled={loadingLoadPreview || (isLoadFlow && !loadTestingEnabled)}>
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
          selection={selection}
          ancestorRequests={ancestorRequests}
          ancestorLocalVariables={ancestorLocalVariables}
          environmentVariables={environmentVariables}
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
    </div>
    {logOpen && (
      <RunLogPanel
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
    </div>
  )
}
