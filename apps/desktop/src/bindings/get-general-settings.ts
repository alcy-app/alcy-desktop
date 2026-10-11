import { invokeResult, type CommandResult } from './invoke-result'

export interface GeneralSettingsDto {
  /** `null` desabilita o timeout das chamadas. */
  requestTimeoutSeconds: number | null
  /** `null` desabilita o limite de tamanho do corpo de resposta (em MB). */
  responseSizeLimitMb: number | null
  /** Dias de retenção do histórico; `0` desativa o histórico. */
  historyRetentionDays: number
  /** Guarda corpo e headers das respostas no histórico; desligado por padrão. */
  saveHistoryResponses: boolean
}

export type GeneralSettingsCommandError =
  | { kind: 'invalid'; message: string }
  | { kind: 'client'; message: string }
  | { kind: 'storage'; message: string }

export function getGeneralSettings(): Promise<CommandResult<GeneralSettingsDto, GeneralSettingsCommandError>> {
  return invokeResult('get_general_settings')
}
