import { createContext } from 'react'
import type { Theme, ThemePreference } from './theme'

export interface ThemeContextValue {
  /** The theme on screen: the preference, with `system` resolved. */
  theme: Theme
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)
