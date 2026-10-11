import { invokeResult, type CommandResult } from './invoke-result'
import type { ValueMonitorDto, ValueMonitorsError } from './list-value-monitors'

/** Grava todos os monitores de uma vez. Um monitor inválido recusa o save e aponta monitor e regra. */
export function saveValueMonitors(rootPath: string, monitors: ValueMonitorDto[]): Promise<CommandResult<null, ValueMonitorsError>> {
  return invokeResult('save_value_monitors', { input: { rootPath, monitors } })
}
