import type { ValueMonitorDto } from '../../bindings/list-value-monitors'
import { mergeResource, record, string, strings } from './agent-resource-data'

/** Names shared by dispatch, translated cards and coverage tests against the native catalog. */
export const RESOURCE_TOOL_NAMES = [
  'list_flows', 'get_flow', 'get_flow_guide', 'get_flow_references', 'check_flow', 'create_flow', 'add_flow_node', 'connect_flow_nodes', 'disconnect_flow_nodes', 'organize_flow', 'update_flow', 'rename_flow_node', 'duplicate_flow', 'delete_flow', 'manage_flow_folder', 'open_flow', 'preview_flow', 'run_flow', 'get_flow_run', 'cancel_flow', 'get_flow_output',
  'list_value_monitors', 'get_value_monitor', 'create_value_monitor', 'update_value_monitor', 'delete_value_monitor', 'evaluate_value_monitors',
  'list_runners', 'open_runner', 'get_runner', 'configure_runner', 'pick_runner_data_file', 'clear_runner_data_file', 'run_runner', 'get_runner_run', 'cancel_runner', 'get_runner_output',
  'list_mock_servers', 'get_mock_server', 'create_mock_server', 'update_mock_server', 'save_mock_server', 'delete_mock_server', 'open_mock_server', 'start_mock_server', 'stop_mock_server', 'list_mock_calls', 'clear_mock_calls',
  'get_collection', 'create_request', 'update_collection_item', 'duplicate_collection_item', 'delete_collection_item', 'set_scope_variable', 'delete_scope_variable',
  'create_environment', 'update_environment', 'delete_environment', 'delete_environment_variable',
] as const
export type ResourceToolName = typeof RESOURCE_TOOL_NAMES[number]
export function isResourceTool(name: string): name is ResourceToolName { return (RESOURCE_TOOL_NAMES as readonly string[]).includes(name) }

function upsert<T extends { id: string }>(existing: T[], value: unknown, create: (entry: Record<string, unknown>) => T): T[] {
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
    if (index < 0) next.push(create(entry))
    else next[index] = mergeResource(next[index], entry) as T
  }
  return next
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
