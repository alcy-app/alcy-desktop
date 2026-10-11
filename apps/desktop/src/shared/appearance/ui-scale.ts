/** Chave herdada da antiga "escala da interface", que só escalava texto; mantida para preservar o valor já salvo. */
export const TEXT_SCALE_STORAGE_KEY = 'alcy:ui-scale'
export const ICON_SCALE_STORAGE_KEY = 'alcy:icon-scale'

export const DEFAULT_UI_SCALE = 1
export const MIN_UI_SCALE = 0.85
export const MAX_UI_SCALE = 1.3
export const UI_SCALE_STEP = 0.05

export function clampUiScale(value: number): number {
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, value))
}

export function isUiScale(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_UI_SCALE && value <= MAX_UI_SCALE
}
