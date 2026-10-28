import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { beginOnedriveLogin } from '../../bindings/begin-onedrive-login'
import { cancelGitlabOperation } from '../../bindings/cancel-gitlab-operation'
import { listOnedriveAccounts } from '../../bindings/list-onedrive-accounts'
import { logoutOnedrive } from '../../bindings/logout-onedrive'
import type { OnedriveAccountDto } from '../../bindings/onedrive-types'
import { FEATURE_FLAGS } from '../feature-flags'
import { OnedriveContext, type OnedriveContextValue } from './onedrive-context'

/** Guarda as contas Microsoft conectadas (os tokens ficam no chaveiro, em Rust) e o login em andamento. */
export function OnedriveProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<OnedriveAccountDto[]>([])
  const [loaded, setLoaded] = useState(!FEATURE_FLAGS.onedrive)
  const [loginOperationId, setLoginOperationId] = useState<string | null>(null)
  const loginOperationRef = useRef<string | null>(null)

  useEffect(() => {
    if (!FEATURE_FLAGS.onedrive) return
    let cancelled = false
    void listOnedriveAccounts().then((result) => {
      if (cancelled) return
      if (result.ok) setAccounts(result.value)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback<OnedriveContextValue['login']>(async (clientId, tenant) => {
    const operationId = crypto.randomUUID()
    loginOperationRef.current = operationId
    setLoginOperationId(operationId)

    const result = await beginOnedriveLogin({ operationId, clientId: clientId.trim(), tenant: tenant.trim() })

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

  const logout = useCallback<OnedriveContextValue['logout']>(async (accountId) => {
    const result = await logoutOnedrive(accountId)
    if (!result.ok) return result
    setAccounts((current) => current.filter((account) => account.id !== accountId))
    return { ok: true }
  }, [])

  const value = useMemo<OnedriveContextValue>(
    () => ({ accounts, loaded, loggingIn: loginOperationId !== null, login, cancelLogin, logout }),
    [accounts, loaded, loginOperationId, login, cancelLogin, logout],
  )

  return <OnedriveContext.Provider value={value}>{children}</OnedriveContext.Provider>
}
