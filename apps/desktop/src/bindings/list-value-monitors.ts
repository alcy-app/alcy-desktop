import { invokeResult, type CommandResult } from './invoke-result'

export type CaseStyle = 'upper' | 'lower' | 'capitalized' | 'title'
export type ValueType = 'string' | 'number' | 'boolean' | 'null'
export type ValueFormat = 'email' | 'uuid' | 'isoDate' | 'isoDateTime' | 'url'

/** Tipo e parâmetros de uma regra — mesmo formato gravado em `alcy-value-monitors.json`. */
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
  | { kind: 'format'; format: ValueFormat }

export type ValueRuleDto = { id: string } & ValueRuleKind

export interface ValueMonitorDto {
  id: string
  name: string
  enabled: boolean
  /** Caminhos de campo, casados pelo sufixo (`nome`, `usuario.nome`). */
  fields: string[]
  rules: ValueRuleDto[]
}

export type ValueMonitorsError =
  | { kind: 'invalid'; message: string; monitorId: string; ruleId: string | null }
  | { kind: 'storage'; message: string }

/** Monitores de valores do workspace (vazio quando o arquivo ainda não existe). */
export function listValueMonitors(rootPath: string): Promise<CommandResult<ValueMonitorDto[], ValueMonitorsError>> {
  return invokeResult('list_value_monitors', { input: { rootPath } })
}
