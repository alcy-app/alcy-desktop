import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_THEME, isTheme, THEME_STORAGE_KEY, type Theme } from './theme'
import { ThemeContext, type ThemeContextValue } from './theme-context'

function readStoredTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isTheme(stored) ? stored : DEFAULT_THEME
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const value = useMemo<ThemeContextValue>(() => ({ theme, setTheme }), [theme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
