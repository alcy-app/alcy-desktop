import { useContext } from 'react'
import { LanguageContext, type LanguageContextValue } from './language-context'

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext)
  if (!context) {
    throw new Error('useLanguage precisa ser usado dentro de LanguageProvider')
  }
  return context
}
