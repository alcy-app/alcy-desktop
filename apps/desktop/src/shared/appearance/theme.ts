export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'alcy:theme'
export const DEFAULT_THEME: Theme = 'light'
export const THEMES: Theme[] = ['light', 'dark']

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark'
}

/** Cores literais de cada tema para o preview em Configurações. Ficam
 * separadas dos tokens CSS para que o cartão mostre a paleta do tema
 * independentemente do tema ativo; mantenha em sincronia com `tokens.css`. */
export const THEME_PREVIEW: Record<Theme, string[]> = {
  light: ['#f4f5f8', '#ffffff', '#2b2f3a', '#5b4bd6', '#15803d', '#b45309', '#dc2626'],
  dark: ['#111216', '#181a20', '#d9dbe2', '#7667e8', '#34d399', '#f5a524', '#f87171'],
}
