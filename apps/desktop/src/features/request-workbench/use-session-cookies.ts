import { useCallback, useEffect, useState } from 'react'
import {
  clearSessionCookies,
  deleteSessionCookie,
  listSessionCookies,
  type SessionCookieDto,
} from '../../bindings/session-cookies'

/**
 * Cópia dos cookies do jar da sessão (backend). Recarregada ao montar,
 * quando `reloadKey` muda (ex.: um envio terminou) e após remover/limpar —
 * nunca a cada tecla.
 */
export function useSessionCookies(reloadKey: unknown) {
  const [cookies, setCookies] = useState<SessionCookieDto[]>([])
  const [localReload, setLocalReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    void listSessionCookies().then((result) => {
      if (!cancelled && result.ok) setCookies(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [reloadKey, localReload])

  const remove = useCallback(async (cookie: SessionCookieDto) => {
    await deleteSessionCookie({ domain: cookie.domain, path: cookie.path, name: cookie.name })
    setLocalReload((value) => value + 1)
  }, [])

  const clear = useCallback(async () => {
    await clearSessionCookies()
    setLocalReload((value) => value + 1)
  }, [])

  return { cookies, remove, clear }
}
