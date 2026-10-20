import { useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, Controls, ReactFlow } from '@xyflow/react'
import type { ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { FlowRunDetailDto } from '../../bindings/get-flow-run-history'
import type { FlowNodeOutputDto } from '../../bindings/get-flow-node-output'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { useLanguage } from '../../shared/i18n/use-language'
import { findRequest, requestMethodLabel } from '../request-workbench/collection-tree'
import type { TreeNode } from '../request-workbench/collection-tree'
import { isSimpleFlowNode, snapViewportToWholePixels, terminalFlowNodeIds, toFlowEdges, toFlowNodes } from './flow-canvas-mapping'
import type { FlowNode } from './flow-canvas-mapping'
import type { FlowEdgeType } from './flow-edge-types'
import { edgeTypes, nodeTypes } from './flow-node-types'
import { isSimpleNode, simpleNodeConfig } from './flows.types'
import { isVisitedStatus } from './flow-run-trail'
import { replayRun } from './replay-run'
import { RunLogPanel } from './RunLogPanel'
import { simpleNodeLogInfo } from './simple-node-types'
import type { RunLogNodeInfo } from './RunLogPanel'
import { edgeFromDto, flowNodeFromDto } from './use-flows-state'
import { FLOW_GEOMETRY as G, flowGeometryStyle } from './flow-geometry'
import { flowLayoutModel } from './flow-layout-model'
import { flowEdgeRoutes } from './flow-layout'
import { displayBodyNodeId } from './display-output-source'
import type { DisplayFormat } from './display-format'
import './flow-canvas.css'
import './flow-studio.css'

interface FlowRunSnapshotProps {
  rootPath?: string
  detail: FlowRunDetailDto
  collections: TreeNode[]
  environmentVariables: EnvironmentVariableDto[]
}

/** Read-only historical graph and execution trail, reconstructed using the live reducers. Mount with the run ID; this view never edits or executes the graph. */
export function FlowRunSnapshot({ detail, collections, environmentVariables, rootPath }: FlowRunSnapshotProps) {
  const { t } = useLanguage()
  const instanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdgeType> | null>(null)
  const [displayFormats, setDisplayFormats] = useState<Record<string, DisplayFormat>>({})

  const nodeStates = useMemo(() => detail.nodes.map(flowNodeFromDto), [detail.nodes])
  const edgeStates = useMemo(() => detail.edges.map(edgeFromDto), [detail.edges])
  const terminalIds = useMemo(() => terminalFlowNodeIds(toFlowNodes(nodeStates), toFlowEdges(edgeStates)), [nodeStates, edgeStates])
  const replayed = useMemo(
    () => replayRun(nodeStates, edgeStates, detail.events, detail.startedAtMs),
    [nodeStates, edgeStates, detail.events, detail.startedAtMs],
  )
  const outputs = useMemo(() => {
    const byNode: Record<string, FlowNodeOutputDto> = {}
    for (const { nodeId, ...output } of detail.outputs) byNode[nodeId] = output
    return byNode
  }, [detail.outputs])

  const nodes = useMemo<FlowNode[]>(
    () =>
      toFlowNodes(nodeStates).map((canonical): FlowNode => {
        const node = { ...canonical, className: terminalIds.has(canonical.id) ? 'flow-terminal-node' : '' }
        const noop = () => {}
        const visited = node.type === 'start' ? replayed.traversedEdges.size > 0 : isVisitedStatus(replayed.statuses[node.id])
        const runStatus = replayed.statuses[node.id] ?? { status: 'idle' as const }
        if (isSimpleFlowNode(node)) {
          const sourceId = node.data.config.kind === 'display' ? displayBodyNodeId(node.data.config.template) : null
          return { ...node, data: { ...node.data, runStatus, visited, readOnly: true,
            displayFormat: displayFormats[node.id] ?? 'auto',
            onDisplayFormatChange: (format: DisplayFormat) => setDisplayFormats((current) => ({ ...current, [node.id]: format })),
            displaySource: sourceId && rootPath ? { rootPath, flowExecutionId: detail.id, nodeId: sourceId } : undefined,
          } }
        }
        if (node.type === 'request') {
          const requestId = node.data.requestId
          return {
            ...node,
            data: {
              ...node.data,
              request: requestId ? findRequest(collections, requestId) : null,
              runStatus,
              visited,
              collections,
              environmentVariables,
              onSelectRequest: noop,
              readOnly: true,
            },
          }
        }
        if (node.type === 'if') return { ...node, data: { ...node.data, runStatus, visited, readOnly: true } }
        if (node.type === 'block') return { ...node, data: { ...node.data, visited, readOnly: true } }
        return { ...node, data: { visited } }
      }),
    [nodeStates, replayed, collections, environmentVariables, terminalIds, displayFormats, rootPath, detail.id],
  )

  const routes = useMemo(() => flowEdgeRoutes(flowLayoutModel(nodes, toFlowEdges(edgeStates))), [nodes, edgeStates])
  const edges = useMemo<FlowEdgeType[]>(
    () =>
      toFlowEdges(edgeStates).map((edge, index) => ({
        ...edge,
        data: { onDelete: () => {}, active: false, traversed: replayed.traversedEdges.has(edge.id), hovered: false, ...routes[index] },
      })),
    [edgeStates, replayed.traversedEdges, routes],
  )

  const nodeInfo = useMemo<Record<string, RunLogNodeInfo>>(() => {
    const info: Record<string, RunLogNodeInfo> = {}
    for (const node of nodeStates) {
      if (isSimpleNode(node)) {
        info[node.id] = simpleNodeLogInfo(simpleNodeConfig(node), t)
      } else if (node.kind === 'start') {
        info[node.id] = { label: t('flows.canvas.startNodeLabel'), kindLabel: '' }
      } else if (node.kind === 'block') {
        info[node.id] = { label: node.label, kindLabel: t('flows.canvas.newBlockLabel') }
      } else if (node.kind === 'if') {
        info[node.id] = { label: t('flows.canvas.ifNodeLabel'), kindLabel: t('flows.canvas.newIfBlockLabel') }
      } else if (node.kind === 'request') {
        const request = findRequest(collections, node.requestId)
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
  }, [nodeStates, collections, t])

  return (
    <div className="flow-canvas-shell flow-studio" style={flowGeometryStyle}>
      <div className="flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          onInit={(instance) => {
            instanceRef.current = instance
          }}
          onMoveEnd={(_event, viewport) => snapViewportToWholePixels(instanceRef.current, viewport)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={G.grid} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <RunLogPanel
        rootPath={rootPath}
        entries={replayed.logEntries}
        nodeInfo={nodeInfo}
        runStartedAtMs={detail.startedAtMs}
        flowExecutionId={rootPath ? detail.id : null}
        isRunning={false}
        outputs={outputs}
      />
    </div>
  )
}
