import type { ScreenshotTheme } from './screenshot-options'

export interface ScreenshotPalette {
  bg: string
  surface: string
  surfaceRaised: string
  border: string
  borderSubtle: string
  text: string
  textMuted: string
  textHeading: string
  accent: string
  accentStrong: string
  onAccent: string
  success: string
  warning: string
  error: string
  info: string
}

export type ColorRole = keyof ScreenshotPalette

/**
 * Cores literais de cada tema, com os nomes dos tokens de `tokens.css`
 * (`surfaceRaised` = `--surface-raised`). A imagem tem tema próprio,
 * independente do app, e os tokens do tema claro ficam em `:root` — com o
 * app no tema escuro não há como lê-los do DOM. Mesma abordagem de
 * `THEME_PREVIEW` (`shared/appearance/theme.ts`); mantenha em sincronia com
 * `tokens.css`.
 */
export const SCREENSHOT_PALETTES: Record<ScreenshotTheme, ScreenshotPalette> = {
  light: {
    bg: '#f4f5f8',
    surface: '#ffffff',
    surfaceRaised: '#f8f9fb',
    border: '#dfe2e8',
    borderSubtle: '#eceef2',
    text: '#2b2f3a',
    textMuted: '#6b7080',
    textHeading: '#14171f',
    accent: '#5b4bd6',
    accentStrong: '#4a3bc0',
    onAccent: '#fff',
    success: '#15803d',
    warning: '#b45309',
    error: '#dc2626',
    info: '#2563eb',
  },
  dark: {
    bg: '#111216',
    surface: '#181a20',
    surfaceRaised: '#1d2027',
    border: '#2a2d35',
    borderSubtle: '#22252c',
    text: '#d9dbe2',
    textMuted: '#9296a2',
    textHeading: '#f3f4f7',
    accent: '#7667e8',
    accentStrong: '#9388f3',
    onAccent: '#fff',
    success: '#34d399',
    warning: '#f5a524',
    error: '#f87171',
    info: '#60a5fa',
  },
}
