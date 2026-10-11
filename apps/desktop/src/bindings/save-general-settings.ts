import type { GeneralSettingsCommandError, GeneralSettingsDto } from './get-general-settings'
import { invokeResult, type CommandResult } from './invoke-result'

/** Aplica nas próximas chamadas e persiste; um valor inválido não é salvo. */
export function saveGeneralSettings(
  input: GeneralSettingsDto,
): Promise<CommandResult<GeneralSettingsDto, GeneralSettingsCommandError>> {
  return invokeResult('save_general_settings', { input })
}
