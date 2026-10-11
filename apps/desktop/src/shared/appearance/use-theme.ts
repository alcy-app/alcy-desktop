import { useContext } from 'react'
import { ThemeContext, type ThemeContextValue } from './theme-context'

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme precisa ser usado dentro de ThemeProvider')
  }
  return context
}
