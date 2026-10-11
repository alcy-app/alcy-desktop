import { invokeResult, type CommandResult } from './invoke-result'
import type { UpdateCommandError, UpdateSettingsDto } from './update-types'

export function getUpdateSettings(): Promise<CommandResult<UpdateSettingsDto, UpdateCommandError>> {
  return invokeResult('get_update_settings')
}
