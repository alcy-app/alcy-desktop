import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { HAR_REDACTION_STORAGE_KEY, readStoredHarRedaction } from './security-preferences'
import { SecurityPreferencesContext, type SecurityPreferencesContextValue } from './security-preferences-context'

export function SecurityPreferencesProvider({ children }: { children: ReactNode }) {
  const [redactHarSensitiveData, setRedactHarSensitiveData] = useState(readStoredHarRedaction)

  useEffect(() => {
    try {
      window.localStorage.setItem(HAR_REDACTION_STORAGE_KEY, String(redactHarSensitiveData))
    } catch {
      // Sem armazenamento a preferência vale só para esta sessão.
    }
  }, [redactHarSensitiveData])

  const value = useMemo<SecurityPreferencesContextValue>(
    () => ({ redactHarSensitiveData, setRedactHarSensitiveData }),
    [redactHarSensitiveData],
  )

  return <SecurityPreferencesContext.Provider value={value}>{children}</SecurityPreferencesContext.Provider>
}
