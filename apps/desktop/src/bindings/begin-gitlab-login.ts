import { invokeResult, type CommandResult } from './invoke-result'
import type { GitlabAccountDto, GitlabCommandError } from './gitlab-types'

export interface BeginGitlabLoginInput {
  operationId: string
  instanceUrl: string
  clientId: string
}

export type BeginGitlabLoginResult = CommandResult<GitlabAccountDto, GitlabCommandError>

/** Abre o navegador e resolve quando o login termina (ou é cancelado por `cancelGitlabOperation`). */
export function beginGitlabLogin(input: BeginGitlabLoginInput): Promise<BeginGitlabLoginResult> {
  return invokeResult('begin_gitlab_login', { input })
}
