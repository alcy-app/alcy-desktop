import { useContext } from 'react'
import { SecurityPreferencesContext, type SecurityPreferencesContextValue } from './security-preferences-context'

export function useSecurityPreferences(): SecurityPreferencesContextValue {
  const context = useContext(SecurityPreferencesContext)
  if (!context) {
    throw new Error('useSecurityPreferences precisa ser usado dentro de SecurityPreferencesProvider')
  }
  return context
}
