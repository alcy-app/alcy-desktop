import type { SessionCookieDto } from '../../bindings/session-cookies'

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  return (
    requestPath === cookiePath ||
    (requestPath.startsWith(cookiePath) &&
      (cookiePath.endsWith('/') || requestPath.slice(cookiePath.length).startsWith('/')))
  )
}

/**
 * Cookies do jar da sessão que vão no envio para `url` — mesmas regras do
 * jar no backend (`cookie_jar.rs`), só para exibir na aba Headers.
 * URL inválida (ex.: ainda com `{{variável}}`) = nenhum.
 */
export function cookiesFor(cookies: SessionCookieDto[], url: string, now = Date.now()): SessionCookieDto[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  const host = parsed.hostname.toLowerCase()
  const secure = parsed.protocol === 'https:'
  return cookies
    .filter(
      (cookie) =>
        (cookie.expiresAtMs === null || cookie.expiresAtMs > now) &&
        (cookie.hostOnly ? cookie.domain === host : domainMatches(host, cookie.domain)) &&
        pathMatches(parsed.pathname, cookie.path) &&
        (secure || !cookie.secure),
    )
    .sort((a, b) => b.path.length - a.path.length)
}

export function cookieHeaderValue(cookies: SessionCookieDto[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}
