import { createContext } from 'react'

export interface SecurityPreferencesContextValue {
  redactHarSensitiveData: boolean
  setRedactHarSensitiveData: (redact: boolean) => void
}

export const SecurityPreferencesContext = createContext<SecurityPreferencesContextValue | null>(null)
