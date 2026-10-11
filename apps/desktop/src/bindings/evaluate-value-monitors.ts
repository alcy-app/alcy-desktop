import { invokeResult, type CommandResult } from './invoke-result'
import type { ValueMonitorDto, ValueMonitorsError } from './list-value-monitors'

/** Valor primitivo da resposta candidato a monitoramento: caminho e literal JSON (`"Ana"`, `12`). */
export interface MonitorCandidateInput {
  path: (string | number)[]
  literal: string
}

/** Resultado de um monitor sobre o candidato `valueIndex`; `failedRuleIds` vazio = aprovado. */
export interface ValueFindingDto {
  valueIndex: number
  monitorId: string
  field: string
  failedRuleIds: string[]
}

/** Avalia os candidatos contra os monitores (os da interface, não os do disco). */
export function evaluateValueMonitors(
  monitors: ValueMonitorDto[],
  values: MonitorCandidateInput[],
): Promise<CommandResult<ValueFindingDto[], ValueMonitorsError>> {
  return invokeResult('evaluate_value_monitors', { input: { monitors, values } })
}
