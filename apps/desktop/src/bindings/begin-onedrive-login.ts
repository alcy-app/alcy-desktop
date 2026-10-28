import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabCommandError } from './gitlab-types'
import type { OnedriveAccountDto } from './onedrive-types'

export interface BeginOnedriveLoginInput {
  operationId: string
  clientId: string
  /** Vazio usa `common` (contas corporativas e pessoais). */
  tenant: string
}

export type BeginOnedriveLoginResult = CommandResult<OnedriveAccountDto, GitlabCommandError>

/** Abre o navegador e resolve quando o login termina (ou é cancelado por `cancelGitlabOperation`). */
export function beginOnedriveLogin(input: BeginOnedriveLoginInput): Promise<BeginOnedriveLoginResult> {
  return invokeResult('begin_onedrive_login', { input })
}
