import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getProxySettings, type ProxySettingsDto } from '../../bindings/get-proxy-settings'
import { saveProxySettings } from '../../bindings/save-proxy-settings'
import { testProxySettings } from '../../bindings/test-proxy-settings'
import { ProxyContext, type ProxyContextValue } from './proxy-context'

const DEFAULT_SETTINGS: ProxySettingsDto = { mode: 'disabled', pacUrl: null }

/** Carrega a configuração de proxy (guardada em Rust) e a compartilha entre o menu de configurações e a barra de status. */
export function ProxyProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ProxySettingsDto>(DEFAULT_SETTINGS)
  const [applyError, setApplyError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getProxySettings().then((result) => {
      if (cancelled || !result.ok) return
      setSettings({ mode: result.value.mode, pacUrl: result.value.pacUrl ?? null })
      setApplyError(result.value.error)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback<ProxyContextValue['save']>(async (input) => {
    const result = await saveProxySettings(input)
    if (!result.ok) return result
    setSettings({ mode: result.value.mode, pacUrl: result.value.pacUrl ?? null })
    setApplyError(result.value.error)
    return { ok: true }
  }, [])

  const value = useMemo<ProxyContextValue>(
    () => ({ settings, applyError, save, test: testProxySettings }),
    [settings, applyError, save],
  )

  return <ProxyContext.Provider value={value}>{children}</ProxyContext.Provider>
}
