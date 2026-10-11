import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEME_STORAGE_KEY } from './theme'
import { ThemeProvider } from './ThemeProvider'
import { useTheme } from './use-theme'

function Probe() {
  const { theme, setTheme } = useTheme()
  return <button onClick={() => setTheme('dark')}>{theme}</button>
}

describe('ThemeProvider', () => {
  it('usa o tema claro por padrão e o aplica no documento', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(DEFAULT_THEME).toBe('light')
    expect(screen.getByRole('button')).toHaveTextContent('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('ignora valor salvo inválido', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('light')
  })

  it('troca e persiste o tema', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    fireEvent.click(screen.getByRole('button'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })
})
