import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_THEME_PREFERENCE, THEME_STORAGE_KEY, type ThemePreference } from './theme'
import { ThemeProvider } from './ThemeProvider'
import { useTheme } from './use-theme'

function Probe({ next = 'dark' }: { next?: ThemePreference }) {
  const { theme, preference, setPreference } = useTheme()
  return <button onClick={() => setPreference(next)}>{`${preference}:${theme}`}</button>
}

/** A system theme the test can switch, like the OS changing it while the app is open. */
function stubSystemTheme(initiallyDark: boolean) {
  let dark = initiallyDark
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' && dark
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }))
  return (nextDark: boolean) => {
    dark = nextDark
    for (const listener of listeners) listener()
  }
}

describe('ThemeProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the light theme by default and applies it to the document', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(DEFAULT_THEME_PREFERENCE).toBe('light')
    expect(screen.getByRole('button')).toHaveTextContent('light:light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('ignores an invalid saved value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('light:light')
  })

  it('switches and persists the theme', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    fireEvent.click(screen.getByRole('button'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('with the system default, follows the operating system, also when it changes', () => {
    const setSystemDark = stubSystemTheme(true)
    render(<ThemeProvider><Probe next="system" /></ThemeProvider>)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveTextContent('system:dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')

    act(() => setSystemDark(false))
    expect(screen.getByRole('button')).toHaveTextContent('system:light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('restores a saved system default', () => {
    stubSystemTheme(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByRole('button')).toHaveTextContent('system:dark')
  })
})
