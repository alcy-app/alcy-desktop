import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { beginGitlabLogin } from '../../bindings/begin-gitlab-login'
import { cancelGitlabOperation } from '../../bindings/cancel-gitlab-operation'
import type { GitlabAccountDto } from '../../bindings/gitlab-types'
import { listGitlabAccounts } from '../../bindings/list-gitlab-accounts'
import { logoutGitlab } from '../../bindings/logout-gitlab'
import { GitlabContext, type GitlabContextValue } from './gitlab-context'

/** Guarda as contas GitLab conectadas (os tokens ficam no chaveiro, em Rust) e o login em andamento. */
export function GitlabProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<GitlabAccountDto[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loginOperationId, setLoginOperationId] = useState<string | null>(null)
  const loginOperationRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void listGitlabAccounts().then((result) => {
      if (cancelled) return
      if (result.ok) setAccounts(result.value)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback<GitlabContextValue['login']>(async (instanceUrl, clientId) => {
    const operationId = crypto.randomUUID()
    loginOperationRef.current = operationId
    setLoginOperationId(operationId)

    const result = await beginGitlabLogin({ operationId, instanceUrl: instanceUrl.trim(), clientId: clientId.trim() })

    loginOperationRef.current = null
    setLoginOperationId(null)
    if (!result.ok) return result

    const account = result.value
    setAccounts((current) => [...current.filter((existing) => existing.id !== account.id), account])
    return { ok: true }
  }, [])

  const cancelLogin = useCallback(() => {
    const operationId = loginOperationRef.current
    if (operationId) void cancelGitlabOperation(operationId)
  }, [])

  const logout = useCallback<GitlabContextValue['logout']>(async (accountId) => {
    const result = await logoutGitlab(accountId)
    if (!result.ok) return result
    setAccounts((current) => current.filter((account) => account.id !== accountId))
    return { ok: true }
  }, [])

  const value = useMemo<GitlabContextValue>(
    () => ({ accounts, loaded, loggingIn: loginOperationId !== null, login, cancelLogin, logout }),
    [accounts, loaded, loginOperationId, login, cancelLogin, logout],
  )

  return <GitlabContext.Provider value={value}>{children}</GitlabContext.Provider>
}
