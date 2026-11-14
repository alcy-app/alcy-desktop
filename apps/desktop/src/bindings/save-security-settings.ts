import type { SecuritySettingsCommandError, SecuritySettingsDto } from './get-security-settings'
import { invokeResult, type CommandResult } from './invoke-result'

/** Saves the given preferences; the ones left out keep their saved value. */
export function saveSecuritySettings(
  input: Partial<SecuritySettingsDto>,
): Promise<CommandResult<SecuritySettingsDto, SecuritySettingsCommandError>> {
  return invokeResult('save_security_settings', { input })
}
