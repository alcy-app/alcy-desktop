import { invokeResult, type CommandResult } from './invoke-result'

export type CaseStyle = 'upper' | 'lower' | 'capitalized' | 'title'
export type ValueType = 'string' | 'number' | 'boolean' | 'null'
export type ValueFormat = 'email' | 'uuid' | 'isoDate' | 'isoDateTime' | 'url' | 'customDateTime'

/** Kind and parameters of a rule, in the same shape written to `alcy-value-monitors.json`. */
export type ValueRuleKind =
  | { kind: 'exactLength'; length: number }
  | { kind: 'lengthRange'; min: number | null; max: number | null }
  | { kind: 'lettersOnly' }
  | { kind: 'digitsOnly' }
  | { kind: 'alphanumeric' }
  | { kind: 'noWhitespace' }
  | { kind: 'notEmpty' }
  | { kind: 'case'; style: CaseStyle }
  | { kind: 'equals' | 'contains' | 'notContains' | 'startsWith' | 'endsWith'; value: string; caseSensitive: boolean }
  | { kind: 'oneOf'; values: string[] }
  | { kind: 'regex'; pattern: string }
  | { kind: 'type'; valueType: ValueType }
  | { kind: 'numberRange'; min: number | null; max: number | null }
  /** `pattern` only for `customDateTime` (`DD/MM/YYYY HH:mm`). */
  | { kind: 'format'; format: ValueFormat; pattern?: string }

export type ValueRuleDto = { id: string } & ValueRuleKind

export interface ValueMonitorDto {
  id: string
  name: string
  enabled: boolean
  /** Field paths, matched by suffix (`name`, `user.name`). */
  fields: string[]
  rules: ValueRuleDto[]
}

export type ValueMonitorsError =
  | { kind: 'invalid'; message: string; monitorId: string; ruleId: string | null }
  | { kind: 'storage'; message: string }

/** Value monitors of the workspace (empty when the file doesn't exist yet). */
export function listValueMonitors(rootPath: string): Promise<CommandResult<ValueMonitorDto[], ValueMonitorsError>> {
  return invokeResult('list_value_monitors', { input: { rootPath } })
}
