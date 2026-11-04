export type Theme = 'light' | 'dark'
/** What the user picks in Settings: a theme, or whichever one the operating system uses. */
export type ThemePreference = Theme | 'system'

export const THEME_STORAGE_KEY = 'alcy:theme'
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light'
export const THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark']
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** The operating system's theme, as the webview reports it; light where it cannot tell. */
export function systemTheme(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_DARK_QUERY).matches ? 'dark' : 'light'
}

const LIGHT_PREVIEW = ['#f4f5f8', '#ffffff', '#2b2f3a', '#5b4bd6', '#15803d', '#b45309', '#dc2626']
const DARK_PREVIEW = ['#111216', '#181a20', '#d9dbe2', '#7667e8', '#34d399', '#f5a524', '#f87171']

/** Cores literais de cada tema para o preview em Configurações. Ficam
 * separadas dos tokens CSS para que o cartão mostre a paleta do tema
 * independentemente do tema ativo; mantenha em sincronia com `tokens.css`.
 * O do sistema mostra metade de cada um. */
export const THEME_PREVIEW: Record<ThemePreference, string[]> = {
  system: [...LIGHT_PREVIEW.slice(0, 4), ...DARK_PREVIEW.slice(0, 4)],
  light: LIGHT_PREVIEW,
  dark: DARK_PREVIEW,
}
