import type { FlowDto, FlowEdgeDto, FlowNodeDto } from '../../bindings/list-flows'
import type { SavedRequestDto } from '../../bindings/list-collections'
import { emptyRequestContent, type RequestProtocol } from '../request-workbench/collection-tree'
import { requestFromDto, requestToDto } from '../request-workbench/use-collections-state'
import { FLOW_GEOMETRY as G, flowNodeSize, snapFlowCoordinate } from '../flows/flow-geometry'
import { layoutFlowGraph, rectanglesOverlap, type LayoutGraph, type LayoutNode } from '../flows/flow-layout'
import { defaultLoadNodeConfig, LOAD_NODE_DEFINITIONS } from '../flows/load-node-config'
import { availableNodeIdentifier, identifierError } from '../flows/node-identifiers'
import type { LoadNodeKindState } from '../flows/flows.types'
import { mergeResource, record, string, strings } from './agent-resource-data'
import { applyRequestPatch, describeRequest } from './agent-tools'

/**
 * Flow editing for the agent (spec 0139): small steps that pick ids,
 * positions and outputs themselves, and errors that say how to fix the call.
 * Every function takes a flow and returns a new one; nothing here saves.
 */

type Input = Record<string, unknown>

/** Request fields written the same way as in update_request and create_request. */
export const AGENT_REQUEST_FIELDS = ['method', 'url', 'headers', 'body', 'query', 'variables', 'authentication', 'preRequestScript', 'postResponseScript', 'routeParams', 'grpc', 'websocket'] as const
/** Saved-request DTO keys a model may copy from elsewhere; they mean something else here. */
const DTO_REQUEST_FIELDS = ['endpoint', 'restBody', 'endpointUrl']
const CONDITION_FIELDS = ['left', 'operator', 'right'] as const
const MAX_LISTED_IDS = 30

/** Output names of a node: branch names, [] for one unnamed output, null for none. */
export function nodeOutputs(node: { kind: string; loadKind?: string }): readonly string[] | null {
  switch (node.kind) {
    case 'request': case 'inlineRequest': return ['success', 'failure']
    case 'if': case 'mockWaitRequest': case 'mockAssertCalls': return ['true', 'false']
    case 'while': return ['loop', 'done']
    case 'note': case 'break': case 'continue': return null
    case 'load': {
      const outputs = LOAD_NODE_DEFINITIONS[node.loadKind as LoadNodeKindState]?.outputs
      return outputs === 'none' ? null : outputs === 'single' || outputs === undefined ? [] : outputs
    }
    default: return []
  }
}

function describeOutputs(node: FlowNodeDto): string {
  const outputs = nodeOutputs(node)
  if (outputs === null) return `Node '${node.id}' (${node.kind}) has no outputs.`
  if (outputs.length === 0) return `Node '${node.id}' (${node.kind}) has one output; omit output.`
  return `Node '${node.id}' (${node.kind}) outputs are ${outputs.map((name) => `'${name}'`).join(', ')}.`
}

function listIds(flow: FlowDto): string {
  const ids = flow.nodes.map((node) => node.id)
  return ids.slice(0, MAX_LISTED_IDS).join(', ') + (ids.length > MAX_LISTED_IDS ? ', …' : '')
}

export function findFlowNode(flow: FlowDto, id: unknown, label = 'nodeId'): FlowNodeDto {
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${label} must be a node id. Nodes: ${listIds(flow)}.`)
  const node = flow.nodes.find((item) => item.id === id)
  if (!node) throw new Error(`No node '${id}' in this flow. Nodes: ${listIds(flow)}.`)
  return node
}

/** The output to use from `source`: the given one if valid, otherwise the first one. */
function resolveOutput(source: FlowNodeDto, output: unknown): string | undefined {
  const outputs = nodeOutputs(source)
  if (outputs === null) throw new Error(describeOutputs(source))
  if (output === undefined || output === null || output === '') return outputs[0]
  if (typeof output !== 'string' || !outputs.includes(output)) throw new Error(`Invalid output '${String(output)}'. ${describeOutputs(source)}`)
  return output
}

function checkTarget(target: FlowNodeDto) {
  if (target.kind === 'start') throw new Error("Nothing can connect into 'start'; the flow begins there.")
  if (target.kind === 'note') throw new Error(`Node '${target.id}' is a note; notes do not connect.`)
}

function box(node: { id: string; kind: string; x: number; y: number; loadKind?: string }): LayoutNode {
  const size = flowNodeSize(node.kind, nodeOutputs(node)?.length ?? 0)
  return { id: node.id, kind: node.kind, position: { x: node.x, y: node.y }, ...size }
}

/** To the right of `after` (or of everything), on the first free row. */
export function placeNode(flow: FlowDto, kind: string, after?: FlowNodeDto, loadKind?: string): { x: number; y: number } {
  const boxes = flow.nodes.map(box)
  const right = (item: LayoutNode) => item.position.x + item.width
  const x = snapFlowCoordinate(after ? right(box(after)) + G.columnGap : boxes.reduce((max, item) => Math.max(max, right(item) + G.columnGap), 0))
  const candidate = box({ id: '', kind, x, y: after ? after.y : 0, loadKind })
  for (let attempt = 0; attempt < 200 && boxes.some((item) => rectanglesOverlap(candidate, item)); attempt++) {
    candidate.position.y = snapFlowCoordinate(candidate.position.y + candidate.height + G.rowGap)
  }
  return { x, y: candidate.position.y }
}

function inlineRequestDto(fields: Input, previous: SavedRequestDto | undefined): SavedRequestDto {
  const misplaced = DTO_REQUEST_FIELDS.filter((key) => fields[key] !== undefined)
  if (misplaced.length > 0) throw new Error(`Unknown request field(s) ${misplaced.join(', ')}: write requests as in update_request (url, method, headers, body, query, variables, authentication).`)
  for (const key of AGENT_REQUEST_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && value.includes('[truncated:')) throw new Error(`request.${key} is truncated text from a read; write only the fields you change.`)
  }
  const base = previous ? requestFromDto(previous) : null
  const protocol = (fields.protocol ?? base?.protocol ?? 'rest') as RequestProtocol
  if (protocol !== 'rest' && protocol !== 'graphql' && protocol !== 'grpc' && protocol !== 'websocket') throw new Error("protocol must be 'rest', 'graphql', 'grpc' or 'websocket'.")
  if (base && base.protocol !== protocol) throw new Error('The protocol of an existing request node cannot change; add a new node.')
  const content = applyRequestPatch(base?.content ?? emptyRequestContent(protocol), fields)
  const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : base?.name ?? 'Request'
  return requestToDto({ id: base?.id ?? crypto.randomUUID(), name, protocol, content })
}

/**
 * Node fields as the agent writes them, turned into the stored shape:
 * `left`/`operator`/`right` form the condition, `serverId` a saved mock
 * source, and `request` uses the update_request fields.
 */
function nodeFields(entry: Input, previous?: FlowNodeDto): Input {
  const fields: Input = { ...entry }
  const kind = fields.kind ?? previous?.kind
  // mockAssertCalls also has an operator, for its call count.
  if ((kind === 'if' || kind === 'while') && CONDITION_FIELDS.some((key) => fields[key] !== undefined)) {
    const condition: Input = { ...(previous && 'condition' in previous ? previous.condition : {}), ...(fields.condition ? record(fields.condition, 'condition') : {}) }
    for (const key of CONDITION_FIELDS) if (fields[key] !== undefined) { condition[key] = String(fields[key]); delete fields[key] }
    fields.condition = condition
  }
  if (typeof fields.serverId === 'string') {
    fields.source = { type: 'saved', serverId: fields.serverId }
    delete fields.serverId
  }
  if (fields.request !== undefined) {
    if (kind !== 'inlineRequest') throw new Error(`request only applies to inlineRequest nodes; a '${String(kind)}' node uses other fields (see get_flow_guide).`)
    fields.request = inlineRequestDto(record(fields.request, 'request'), previous?.kind === 'inlineRequest' ? previous.request : undefined)
  }
  return fields
}

function newNode(entry: Input, position: { x: number; y: number }): FlowNodeDto {
  const kind = string(entry, 'kind')
  const defaults: Input = { id: entry.id, kind, ...position }
  switch (kind) {
    case 'start': throw new Error("A flow has a single 'start' node, created with the flow.")
    case 'break': case 'continue': break
    case 'block': defaults.label = 'Block'; break
    case 'request': string(entry, 'requestId'); break
    case 'inlineRequest': if (entry.request === undefined) defaults.request = inlineRequestDto({}, undefined); break
    case 'if': defaults.condition = { left: '', operator: 'equals', right: '' }; break
    case 'while': defaults.condition = { left: '', operator: 'equals', right: '' }; defaults.maxIterations = '100'; break
    case 'humanAction': defaults.form = { title: '', description: '', sections: [] }; break
    case 'note': Object.assign(defaults, { text: '', width: 300, height: 160 }); break
    case 'log': defaults.message = ''; break
    case 'display': defaults.template = ''; break
    case 'sleep': defaults.durationMs = '1000'; break
    case 'setVariables': defaults.assignments = []; break
    case 'load': {
      const loadKind = string(entry, 'loadKind') as LoadNodeKindState
      if (!(loadKind in LOAD_NODE_DEFINITIONS)) throw new Error(`Unknown loadKind '${loadKind}'.`)
      defaults.label = loadKind
      defaults.config = defaultLoadNodeConfig(loadKind)
      break
    }
    case 'mockStart': record(entry.source, 'source (or serverId)'); break
    case 'mockStop': string(entry, 'startNodeId'); break
    case 'mockWaitRequest': string(entry, 'startNodeId'); string(entry, 'routeId'); defaults.timeoutMs = '30000'; break
    case 'mockSetResponse': string(entry, 'startNodeId'); string(entry, 'routeId'); defaults.responseId = null; break
    case 'mockAssertCalls': string(entry, 'startNodeId'); string(entry, 'routeId'); defaults.operator = 'equals'; defaults.count = '1'; break
    default: throw new Error(`Unknown node kind '${kind}'. See get_flow_guide.`)
  }
  return mergeResource(defaults, entry) as FlowNodeDto
}

function connect(flow: FlowDto, from: unknown, to: unknown, output: unknown): { flow: FlowDto; edge: FlowEdgeDto; existing: boolean } {
  const source = findFlowNode(flow, from, 'from')
  const target = findFlowNode(flow, to, 'to')
  if (source.id === target.id) throw new Error('A node cannot connect to itself; use a While node to repeat steps.')
  checkTarget(target)
  const sourceHandle = resolveOutput(source, output)
  const same = flow.edges.find((edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id && (edge.sourceHandle ?? undefined) === sourceHandle)
  if (same) return { flow, edge: same, existing: true }
  const edge: FlowEdgeDto = { id: crypto.randomUUID(), sourceNodeId: source.id, targetNodeId: target.id, ...(sourceHandle ? { sourceHandle } : {}) }
  return { flow: { ...flow, edges: [...flow.edges, edge] }, edge, existing: false }
}

/** connect_flow_nodes: idempotent, so a repeated call returns the same connection. */
export function connectFlowNodes(flow: FlowDto, input: Input) {
  const result = connect(flow, input.from, input.to, input.output)
  return {
    flow: result.flow,
    result: { edgeId: result.edge.id, from: result.edge.sourceNodeId, to: result.edge.targetNodeId, output: result.edge.sourceHandle ?? null, ...(result.existing ? { alreadyConnected: true } : {}) },
  }
}

export function disconnectFlowNodes(flow: FlowDto, input: Input) {
  const removed = typeof input.edgeId === 'string'
    ? flow.edges.filter((edge) => edge.id === input.edgeId)
    : flow.edges.filter((edge) => edge.sourceNodeId === findFlowNode(flow, input.from, 'from').id && edge.targetNodeId === findFlowNode(flow, input.to, 'to').id && (input.output == null || edge.sourceHandle === input.output))
  if (removed.length === 0) throw new Error('No such connection. Read the flow with get_flow to see its connections.')
  const ids = new Set(removed.map((edge) => edge.id))
  return { flow: { ...flow, edges: flow.edges.filter((edge) => !ids.has(edge.id)) }, result: { removedEdges: removed.map((edge) => ({ edgeId: edge.id, from: edge.sourceNodeId, to: edge.targetNodeId, output: edge.sourceHandle ?? null })) } }
}

/** Fields of add_flow_node that describe the node rather than where it goes. */
const PLACEMENT_FIELDS = ['flowId', 'after', 'output', 'before', 'beforeOutput', 'name', 'protocol', ...AGENT_REQUEST_FIELDS]

/** add_flow_node: one node, optionally connected after `after` and before `before`. */
export function addFlowNode(flow: FlowDto, input: Input) {
  const kind = string(input, 'kind')
  const after = input.after === undefined ? undefined : findFlowNode(flow, input.after, 'after')
  const before = input.before === undefined ? undefined : findFlowNode(flow, input.before, 'before')
  if (before && !after) throw new Error('before needs after: the new node goes between after and before.')
  let id: string
  if (input.id !== undefined) {
    id = string(input, 'id')
    const problem = identifierError(id, '', flow.nodes)
    if (problem === 'duplicate') throw new Error(`Node '${id}' already exists. Pick another id, or change it with update_flow.`)
    if (problem === 'invalid') throw new Error(`Invalid id '${id}': use 1 to 64 letters, digits, '_' or '-'.`)
  } else {
    const label = [input.name, input.label, kind === 'inlineRequest' || kind === 'request' ? 'request' : kind].find((value) => typeof value === 'string' && value.trim())
    id = availableNodeIdentifier(String(label), flow.nodes)
  }
  const entry: Input = Object.fromEntries(Object.entries(input).filter(([key]) => !PLACEMENT_FIELDS.includes(key)))
  entry.id = id
  if (kind === 'inlineRequest') {
    const request: Input = entry.request === undefined ? {} : { ...record(entry.request, 'request') }
    for (const key of ['name', 'protocol', ...AGENT_REQUEST_FIELDS]) if (input[key] !== undefined && request[key] === undefined) request[key] = input[key]
    entry.request = request
  }
  const node = newNode(nodeFields(entry), placeNode(flow, kind, after, typeof input.loadKind === 'string' ? input.loadKind : undefined))
  let next: FlowDto = { ...flow, nodes: [...flow.nodes, node] }
  const connected: { from: string; to: string; output: string | null }[] = []
  if (after) {
    // Inserting reuses the output that already leads to `before` when none is given.
    const between = before && (input.output === undefined || input.output === null) ? next.edges.filter((edge) => edge.sourceNodeId === after.id && edge.targetNodeId === before.id) : []
    const output = between.length === 1 ? between[0].sourceHandle ?? undefined : resolveOutput(after, input.output)
    if (before) {
      const existing = next.edges.find((edge) => edge.sourceNodeId === after.id && edge.targetNodeId === before.id && (edge.sourceHandle ?? undefined) === output)
      if (!existing) throw new Error(`'${after.id}' is not connected to '${before.id}'${output ? ` through '${output}'` : ''}, so there is nothing to insert into. Omit before, or use connect_flow_nodes.`)
      next = { ...next, edges: next.edges.filter((edge) => edge.id !== existing.id) }
    }
    next = connect(next, after.id, node.id, output).flow
    connected.push({ from: after.id, to: node.id, output: output ?? null })
    if (before) {
      const beforeOutput = resolveOutput(node, input.beforeOutput)
      next = connect(next, node.id, before.id, beforeOutput).flow
      connected.push({ from: node.id, to: before.id, output: beforeOutput ?? null })
    }
  }
  const outputs = nodeOutputs(node)
  return {
    flow: next,
    result: {
      nodeId: node.id, kind: node.kind, connected,
      outputs: outputs === null ? 'none' : outputs.length === 0 ? 'one (no output name)' : outputs,
      ...(producedReferences(node).length ? { references: producedReferences(node) } : {}),
      next: outputs === null ? 'This node has no outputs.' : `Add the next step with add_flow_node after '${node.id}'${outputs.length ? ` and output '${outputs[0]}'` : ''}.`,
    },
  }
}

export interface FlowPatchResult { flow: FlowDto; notes: string[] }

/** update_flow: merge nodes and edges by id, fill defaults, then check every connection. */
export function patchFlow(flow: FlowDto, input: Input): FlowPatchResult {
  const notes: string[] = []
  const removed = new Set(input.removeNodeIds === undefined ? [] : strings(input.removeNodeIds, 'removeNodeIds'))
  if (flow.nodes.some((node) => removed.has(node.id) && node.kind === 'start')) throw new Error('The Start node cannot be removed.')
  let next: FlowDto = { ...flow, nodes: flow.nodes.filter((node) => !removed.has(node.id)), edges: flow.edges.filter((edge) => !removed.has(edge.sourceNodeId) && !removed.has(edge.targetNodeId)) }
  const removedEdges = new Set(input.removeEdgeIds === undefined ? [] : strings(input.removeEdgeIds, 'removeEdgeIds'))
  next.edges = next.edges.filter((edge) => !removedEdges.has(edge.id))

  const upsertNodes = input.upsertNodes === undefined ? [] : input.upsertNodes
  if (!Array.isArray(upsertNodes)) throw new Error('upsertNodes must be a list.')
  const upsertEdges = input.upsertEdges === undefined ? [] : input.upsertEdges
  if (!Array.isArray(upsertEdges)) throw new Error('upsertEdges must be a list.')
  const seen = new Set<string>()
  const placeLater: Input[] = []
  for (const [index, raw] of upsertNodes.entries()) {
    const entry = record(raw, `upsertNodes[${index}]`)
    const id = string(entry, 'id')
    if (seen.has(id)) throw new Error(`Repeated node id '${id}' in upsertNodes.`)
    seen.add(id)
    const previous = next.nodes.find((node) => node.id === id)
    if (previous) {
      if (entry.kind !== undefined && entry.kind !== previous.kind) throw new Error(`Node '${id}' is a ${previous.kind}; a node kind cannot change. Remove it and add a new node.`)
      next.nodes = next.nodes.map((node) => node.id === id ? mergeResource(node, nodeFields(entry, node)) as FlowNodeDto : node)
    } else {
      const problem = identifierError(id, '', next.nodes)
      if (problem === 'invalid') throw new Error(`Invalid node id '${id}': use 1 to 64 letters, digits, '_' or '-'.`)
      if (entry.kind === undefined) throw new Error(`New node '${id}' needs kind. See get_flow_guide.`)
      placeLater.push(entry)
      next.nodes = [...next.nodes, newNode(nodeFields(entry), { x: 0, y: 0 })]
    }
  }
  for (const [index, raw] of upsertEdges.entries()) {
    const entry = record(raw, `upsertEdges[${index}]`)
    const existing = typeof entry.id === 'string' ? next.edges.find((edge) => edge.id === entry.id) : undefined
    const from = entry.sourceNodeId ?? existing?.sourceNodeId
    const to = entry.targetNodeId ?? existing?.targetNodeId
    const output = entry.sourceHandle === undefined ? existing?.sourceHandle : entry.sourceHandle
    if (existing) next.edges = next.edges.filter((edge) => edge.id !== existing.id)
    const source = findFlowNode(next, from, `upsertEdges[${index}].sourceNodeId`)
    const outputs = nodeOutputs(source)
    if ((output === undefined || output === null) && outputs && outputs.length > 0) notes.push(`Connection ${source.id} → ${String(to)} uses output '${outputs[0]}' (none was given).`)
    const result = connect(next, from, to, output)
    if (typeof entry.id === 'string' && !result.existing) result.edge.id = entry.id
    next = result.flow
  }
  // New nodes without coordinates go after the node that leads into them; the
  // ones still waiting for a place do not count as obstacles.
  const pending = new Set(placeLater.filter((entry) => typeof entry.x !== 'number' || typeof entry.y !== 'number').map((entry) => String(entry.id)))
  for (const id of [...pending]) {
    pending.delete(id)
    const node = findFlowNode(next, id)
    const incoming = next.edges.find((edge) => edge.targetNodeId === id)
    const others = { ...next, nodes: next.nodes.filter((item) => item.id !== id && !pending.has(item.id)) }
    const position = placeNode(others, node.kind, incoming ? next.nodes.find((item) => item.id === incoming.sourceNodeId) : undefined, 'loadKind' in node ? node.loadKind : undefined)
    next.nodes = next.nodes.map((item) => item.id === id ? { ...item, ...position } : item)
  }
  for (const edge of next.edges) {
    const source = findFlowNode(next, edge.sourceNodeId)
    const target = findFlowNode(next, edge.targetNodeId)
    checkTarget(target)
    const outputs = nodeOutputs(source)
    const handle = edge.sourceHandle ?? undefined
    if (outputs === null || (outputs.length === 0 && handle !== undefined) || (outputs.length > 0 && (handle === undefined || !outputs.includes(handle)))) {
      throw new Error(`Connection ${source.id} → ${target.id}${handle ? ` with output '${handle}'` : ''} is invalid. ${describeOutputs(source)}`)
    }
  }
  if (input.name !== undefined) next.name = string(input, 'name').trim()
  if (input.presentation !== undefined) next.presentation = mergeResource(flow.presentation, record(input.presentation, 'presentation')) as FlowDto['presentation']
  if (next.presentation) next.presentation = { panels: next.presentation.panels.filter((panel) => !removed.has(panel.nodeId)) }
  return { flow: { ...next, updatedAtMs: Date.now() }, notes }
}

export function layoutGraph(flow: FlowDto): LayoutGraph {
  return { nodes: flow.nodes.map(box), edges: flow.edges.map((edge) => ({ source: edge.sourceNodeId, target: edge.targetNodeId, sourceHandle: edge.sourceHandle })) }
}

/** organize_flow: the canvas layout, applied to every node it places. */
export function organizeFlow(flow: FlowDto, positions = layoutFlowGraph(layoutGraph(flow))): FlowDto {
  return { ...flow, nodes: flow.nodes.map((node) => positions[node.id] ? { ...node, ...positions[node.id] } : node) }
}

function short(text: string, max = 100): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function nodeSummary(node: FlowNodeDto, requestName: (id: string) => string | undefined): string {
  switch (node.kind) {
    case 'inlineRequest': {
      const content = requestFromDto(node.request).content
      const verb = node.request.protocol === 'rest' ? content.method.toUpperCase() : node.request.protocol
      return short(`${node.request.name}: ${verb} ${content.endpointUrl || '(no URL)'}`)
    }
    case 'request': return short(`saved request ${requestName(node.requestId) ?? `'${node.requestId}' (not found)`}`)
    case 'if': case 'while': return short(`${node.condition.left} ${node.condition.operator} ${node.condition.right}`)
    case 'log': return short(node.message)
    case 'display': return short(node.template)
    case 'note': return short(node.text, 60)
    case 'sleep': return `${node.durationMs} ms`
    case 'setVariables': return short(node.assignments.map((item) => item.name).join(', '))
    case 'block': case 'load': return short(node.label)
    case 'humanAction': return short(node.form.title || 'form')
    case 'mockStart': return node.source.type === 'saved' ? `saved mock ${node.source.serverId}` : `inline mock ${node.source.server.name}`
    case 'start': return node.form ? 'with form' : ''
    default: return 'startNodeId' in node ? `mock of ${node.startNodeId}` : ''
  }
}

/** get_flow outline: one line per node with where each output goes. */
export function flowOutline(flow: FlowDto, requestName: (id: string) => string | undefined = () => undefined) {
  return flow.nodes.map((node) => {
    const next: Record<string, string[]> = {}
    for (const edge of flow.edges.filter((item) => item.sourceNodeId === node.id)) (next[edge.sourceHandle ?? 'next'] ??= []).push(edge.targetNodeId)
    const summary = nodeSummary(node, requestName)
    return { id: node.id, kind: node.kind, ...(summary ? { summary } : {}), ...(Object.keys(next).length ? { next } : {}) }
  })
}

/** A node as the agent reads it: inline requests use the update_request fields. */
export function describeFlowNode(node: FlowNodeDto): unknown {
  if (node.kind !== 'inlineRequest') return node
  const request = requestFromDto(node.request)
  return { ...node, request: { name: request.name, ...describeRequest(request.content) } }
}

/** References other nodes can use once this node ran. */
export function producedReferences(node: FlowNodeDto): string[] {
  const at = (path: string) => `{{nodes.${node.id}.${path}}}`
  switch (node.kind) {
    case 'request': case 'inlineRequest': return [at('response.status'), at('response.body'), at('response.body.<path>'), at('response.headers.<name>')]
    case 'humanAction': return node.form.sections.flatMap((section) => section.fields).map((field) => at(`form.${field.id}`))
    case 'start': return (node.form?.sections ?? []).flatMap((section) => section.fields).map((field) => at(`form.${field.id}`))
    case 'mockStart': return [at('server.url')]
    case 'mockWaitRequest': return [at('request.method'), at('request.path'), at('request.body.<path>'), at('request.query.<name>'), at('request.headers.<name>'), at('request.params.<name>')]
    default: return []
  }
}

/** get_flow_references: what a node can use, from the nodes that run before it. */
export function flowReferences(flow: FlowDto, nodeId: unknown, environmentVariables: string[]) {
  const node = findFlowNode(flow, nodeId)
  const incoming = new Map<string, string[]>()
  for (const edge of flow.edges) incoming.set(edge.targetNodeId, [...(incoming.get(edge.targetNodeId) ?? []), edge.sourceNodeId])
  const ancestors = new Set<string>()
  const queue = [node.id]
  while (queue.length) for (const source of incoming.get(queue.shift()!) ?? []) if (!ancestors.has(source)) { ancestors.add(source); queue.push(source) }
  const before = flow.nodes.filter((item) => ancestors.has(item.id))
  return {
    nodeId: node.id,
    fromEarlierNodes: before.map((item) => ({ nodeId: item.id, kind: item.kind, references: producedReferences(item) })).filter((item) => item.references.length > 0),
    flowVariables: [...new Set(before.flatMap((item) => item.kind === 'setVariables' ? item.assignments.map((assignment) => `{{${assignment.name.trim()}}}`) : []))],
    environmentVariables: environmentVariables.map((name) => `{{${name}}}`),
    hint: ancestors.size === 0 ? `Nothing runs before '${node.id}' yet; connect earlier steps to it first.` : 'Replace <path> with a field path such as data.items.0.id; get_flow_output shows real values after a run.',
  }
}
