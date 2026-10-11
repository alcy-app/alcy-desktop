import { invokeResult, type CommandResult } from './invoke-result'
import type { UpdateCommandError, UpdateSettingsDto } from './update-types'

export function setUpdateCheckOnStartup(enabled: boolean): Promise<CommandResult<UpdateSettingsDto, UpdateCommandError>> {
  return invokeResult('set_update_check_on_startup', { input: { enabled } })
}
