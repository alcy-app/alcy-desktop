import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { DEFAULT_THEME_PREFERENCE, isThemePreference, SYSTEM_DARK_QUERY, systemTheme, THEME_STORAGE_KEY, type ThemePreference } from './theme'
import { ThemeContext, type ThemeContextValue } from './theme-context'

function readStoredPreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE
}

/** Follows the operating system switching between light and dark while the app is open. */
function subscribeSystemTheme(listener: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference)
  const system = useSyncExternalStore(subscribeSystemTheme, systemTheme)
  const theme = preference === 'system' ? system : preference

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  }, [preference])

  const value = useMemo<ThemeContextValue>(() => ({ theme, preference, setPreference }), [theme, preference])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
