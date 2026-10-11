import { invokeResult, type CommandResult } from './invoke-result'
import type { FileStatusDto, GitlabCommandError } from './gitlab-types'

export type GetLocalVersionStatusResult = CommandResult<FileStatusDto[], GitlabCommandError>

/**
 * Estado dos arquivos rastreados só a partir do disco (hash local × base
 * salva, sem chamar o GitLab) — para refletir uma edição local na hora, sem
 * gerar uma consulta ao remoto. Nunca devolve `remoteChanged`/`conflict`;
 * só `getVersionStatus` (que consulta o remoto) sabe disso.
 */
export function getLocalVersionStatus(rootPath: string): Promise<GetLocalVersionStatusResult> {
  return invokeResult('get_local_version_status', { input: { rootPath } })
}
