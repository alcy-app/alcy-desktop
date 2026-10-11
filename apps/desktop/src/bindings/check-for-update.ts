import { invokeResult, type CommandResult } from './invoke-result'
import type { UpdateCheckDto, UpdateCommandError } from './update-types'

export function checkForUpdate(operationId: string): Promise<CommandResult<UpdateCheckDto, UpdateCommandError>> {
  return invokeResult('check_for_update', { input: { operationId } })
}
