import { createContext } from 'react'
import type { Language, TranslationKey, TranslationParams } from './translations'

export interface LanguageContextValue {
  language: Language
  setLanguage: (language: Language) => void
  t: (key: TranslationKey, params?: TranslationParams) => string
}

export const LanguageContext = createContext<LanguageContextValue | null>(null)
