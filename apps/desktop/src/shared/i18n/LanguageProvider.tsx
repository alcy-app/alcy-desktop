import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { LanguageContext, type LanguageContextValue } from './language-context'
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, translate, type Language } from './translations'

function isLanguage(value: string | null): value is Language {
  return value === 'pt-BR' || value === 'en'
}

function readStoredLanguage(): Language {
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
  return isLanguage(stored) ? stored : DEFAULT_LANGUAGE
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(readStoredLanguage)

  useEffect(() => {
    document.documentElement.lang = language
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  }, [language])

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key, params) => translate(language, key, params),
    }),
    [language],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}
