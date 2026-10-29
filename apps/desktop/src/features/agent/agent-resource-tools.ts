import type { FlowDto, FlowNodeDto } from '../../bindings/list-flows'
import type { ValueMonitorDto } from '../../bindings/list-value-monitors'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import { requestToDto } from '../request-workbench/use-collections-state'
import { defaultLoadNodeConfig } from '../flows/load-node-config'
import { isFlowSourceHandle } from '../flows/flows.types'
import { mergeResource, record, string, strings } from './agent-resource-data'

/** Names shared by dispatch, translated cards and coverage tests against the native catalog. */
export const RESOURCE_TOOL_NAMES = [
  'list_flows', 'get_flow', 'create_flow', 'update_flow', 'rename_flow_node', 'duplicate_flow', 'delete_flow', 'manage_flow_folder', 'open_flow', 'preview_flow', 'run_flow', 'get_flow_run', 'cancel_flow', 'get_flow_output',
  'list_value_monitors', 'get_value_monitor', 'create_value_monitor', 'update_value_monitor', 'delete_value_monitor', 'evaluate_value_monitors',
  'list_runners', 'open_runner', 'get_runner', 'configure_runner', 'pick_runner_data_file', 'clear_runner_data_file', 'run_runner', 'get_runner_run', 'cancel_runner', 'get_runner_output',
  'list_mock_servers', 'get_mock_server', 'create_mock_server', 'update_mock_server', 'save_mock_server', 'delete_mock_server', 'open_mock_server', 'start_mock_server', 'stop_mock_server', 'list_mock_calls', 'clear_mock_calls',
  'get_collection', 'update_collection_item', 'duplicate_collection_item', 'delete_collection_item', 'set_scope_variable', 'delete_scope_variable',
  'create_environment', 'update_environment', 'delete_environment', 'delete_environment_variable',
] as const
export type ResourceToolName = typeof RESOURCE_TOOL_NAMES[number]
export function isResourceTool(name: string): name is ResourceToolName { return (RESOURCE_TOOL_NAMES as readonly string[]).includes(name) }

function upsert<T extends { id: string }>(existing: T[], value: unknown, create: (entry: Record<string, unknown>, index: number) => T): T[] {
  if (value === undefined) return existing
  if (!Array.isArray(value)) throw new Error('Upserts must be a list.')
  const next = [...existing]
  const seen = new Set<string>()
  for (const raw of value) {
    const entry = record(raw)
    const id = string(entry, 'id')
    if (seen.has(id)) throw new Error(`Repeated id '${id}'.`)
    seen.add(id)
    const index = next.findIndex((item) => item.id === id)
    if (index < 0) next.push(create(entry, next.length))
    else next[index] = mergeResource(next[index], entry) as T
  }
  return next
}

function newFlowNode(entry: Record<string, unknown>, index: number): FlowNodeDto {
  const kind = string(entry, 'kind')
  const defaults: Record<string, unknown> = { id: entry.id, kind, x: 260 * index, y: 0 }
  switch (kind) {
    case 'start': case 'break': case 'continue': break
    case 'block': defaults.label = 'Block'; break
    case 'request': string(entry, 'requestId'); break
    case 'inlineRequest': {
      const request = record(entry.request, 'request')
      const protocol = request.protocol ?? 'rest'
      if (protocol !== 'rest' && protocol !== 'graphql' && protocol !== 'grpc') throw new Error('Invalid request protocol.')
      defaults.request = requestToDto({ id: crypto.randomUUID(), name: 'Request', protocol, content: emptyRequestContent(protocol) })
      break
    }
    case 'if': defaults.condition = { left: '', operator: 'equals', right: '' }; break
    case 'while': defaults.condition = { left: '', operator: 'equals', right: '' }; defaults.maxIterations = 100; break
    case 'humanAction': defaults.form = { title: '', description: '', sections: [] }; break
    case 'note': Object.assign(defaults, { text: '', width: 300, height: 160 }); break
    case 'log': defaults.message = ''; break
    case 'display': defaults.template = ''; break
    case 'sleep': defaults.durationMs = 1000; break
    case 'setVariables': defaults.assignments = []; break
    case 'load': {
      const loadKind = string(entry, 'loadKind') as Parameters<typeof defaultLoadNodeConfig>[0]
      defaults.label = loadKind
      defaults.config = defaultLoadNodeConfig(loadKind)
      if (defaults.config === undefined) throw new Error('Invalid load node kind.')
      break
    }
    case 'mockStart': record(entry.source, 'source'); break
    case 'mockStop': string(entry, 'startNodeId'); break
    case 'mockWaitRequest': string(entry, 'startNodeId'); string(entry, 'routeId'); defaults.timeoutMs = 30_000; break
    case 'mockSetResponse': string(entry, 'startNodeId'); string(entry, 'routeId'); defaults.responseId = null; break
    case 'mockAssertCalls': string(entry, 'startNodeId'); string(entry, 'routeId'); defaults.operator = 'equals'; defaults.count = 1; break
    default: throw new Error(`Unknown node kind '${kind}'.`)
  }
  return mergeResource(defaults, entry) as FlowNodeDto
}

/** Apply a bounded graph edit without replacing unrelated nodes or masked inline secrets. */
export function patchFlow(flow: FlowDto, input: Record<string, unknown>): FlowDto {
  const removed = new Set(input.removeNodeIds === undefined ? [] : strings(input.removeNodeIds, 'removeNodeIds'))
  if (flow.nodes.some((node) => removed.has(node.id) && node.kind === 'start')) throw new Error('The Start node cannot be removed.')
  const nodes = upsert(flow.nodes.filter((node) => !removed.has(node.id)), input.upsertNodes, newFlowNode)
  for (const node of nodes) {
    const before = flow.nodes.find((item) => item.id === node.id)
    if (before && before.kind !== node.kind) throw new Error('Changing a node kind is unsupported; add a new node.')
  }
  const removedEdges = new Set(input.removeEdgeIds === undefined ? [] : strings(input.removeEdgeIds, 'removeEdgeIds'))
  const edges = upsert(flow.edges.filter((edge) => !removedEdges.has(edge.id) && !removed.has(edge.sourceNodeId) && !removed.has(edge.targetNodeId)), input.upsertEdges, (entry) => ({
    id: string(entry, 'id'), sourceNodeId: string(entry, 'sourceNodeId'), targetNodeId: string(entry, 'targetNodeId'),
    ...(entry.sourceHandle != null ? { sourceHandle: String(entry.sourceHandle) } : {}),
  }))
  for (const edge of edges) if (edge.sourceHandle != null && !isFlowSourceHandle(edge.sourceHandle)) throw new Error('Invalid edge sourceHandle.')
  const result = { ...flow, nodes, edges, updatedAtMs: Date.now() }
  if (input.name !== undefined) result.name = string(input, 'name').trim()
  if (input.presentation !== undefined) result.presentation = mergeResource(flow.presentation, record(input.presentation)) as FlowDto['presentation']
  if (result.presentation) result.presentation = { panels: result.presentation.panels.filter((panel) => !removed.has(panel.nodeId)) }
  return result
}

export function patchMonitor(monitor: ValueMonitorDto, input: Record<string, unknown>): ValueMonitorDto {
  const result = { ...monitor }
  if (input.name !== undefined) result.name = string(input, 'name').trim()
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean.')
    result.enabled = input.enabled
  }
  if (input.fields !== undefined) result.fields = strings(input.fields, 'fields').map((field) => field.trim())
  if (input.addFields !== undefined) result.fields = [...new Set([...result.fields, ...strings(input.addFields, 'addFields').map((field) => field.trim())])]
  if (input.removeFields !== undefined) {
    const removed = new Set(strings(input.removeFields, 'removeFields'))
    result.fields = result.fields.filter((field) => !removed.has(field))
  }
  if (input.rules !== undefined) {
    if (!Array.isArray(input.rules)) throw new Error('rules must be a list.')
    result.rules = input.rules.map((raw) => {
      const rule = record(raw, 'rule')
      return { ...rule, id: typeof rule.id === 'string' ? rule.id : crypto.randomUUID() } as ValueMonitorDto['rules'][number]
    })
  }
  if (input.upsertRules !== undefined) {
    if (!Array.isArray(input.upsertRules)) throw new Error('upsertRules must be a list.')
    const rules = input.upsertRules.map((raw) => {
      const rule = record(raw, 'rule')
      return { ...rule, id: typeof rule.id === 'string' ? rule.id : crypto.randomUUID() }
    })
    result.rules = upsert(result.rules, rules, (entry) => entry as ValueMonitorDto['rules'][number])
  }
  if (input.removeRuleIds !== undefined) {
    const removed = new Set(strings(input.removeRuleIds, 'removeRuleIds'))
    result.rules = result.rules.filter((rule) => !removed.has(rule.id))
  }
  return result
}
