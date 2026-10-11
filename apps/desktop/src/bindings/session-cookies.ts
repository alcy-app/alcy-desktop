import { invokeResult, type CommandResult } from './invoke-result'

/** Cookie guardado na sessão do app (só em memória; some ao fechar o app). */
export interface SessionCookieDto {
  name: string
  value: string
  /** Em minúsculas, sem ponto inicial. */
  domain: string
  /** Sem atributo `Domain`: só o host exato recebe o cookie. */
  hostOnly: boolean
  path: string
  secure: boolean
  /** `null` = cookie de sessão. */
  expiresAtMs: number | null
}

export function listSessionCookies(): Promise<CommandResult<SessionCookieDto[], unknown>> {
  return invokeResult('list_session_cookies')
}

export function deleteSessionCookie(
  key: Pick<SessionCookieDto, 'domain' | 'path' | 'name'>,
): Promise<CommandResult<void, unknown>> {
  return invokeResult('delete_session_cookie', { key })
}

export function clearSessionCookies(): Promise<CommandResult<void, unknown>> {
  return invokeResult('clear_session_cookies')
}
