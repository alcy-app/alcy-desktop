import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { UiScaleContext, type UiScaleContextValue } from './ui-scale-context'
import { clampUiScale, DEFAULT_UI_SCALE, ICON_SCALE_STORAGE_KEY, isUiScale, TEXT_SCALE_STORAGE_KEY } from './ui-scale'

function readStoredScale(key: string): number {
  const stored = window.localStorage.getItem(key)
  if (!stored) return DEFAULT_UI_SCALE
  const parsed = Number(stored)
  return isUiScale(parsed) ? parsed : DEFAULT_UI_SCALE
}

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [textScale, setTextScaleState] = useState<number>(() => readStoredScale(TEXT_SCALE_STORAGE_KEY))
  const [iconScale, setIconScaleState] = useState<number>(() => readStoredScale(ICON_SCALE_STORAGE_KEY))

  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', String(textScale))
    window.localStorage.setItem(TEXT_SCALE_STORAGE_KEY, String(textScale))
  }, [textScale])

  useEffect(() => {
    document.documentElement.style.setProperty('--icon-scale', String(iconScale))
    window.localStorage.setItem(ICON_SCALE_STORAGE_KEY, String(iconScale))
  }, [iconScale])

  const value = useMemo<UiScaleContextValue>(
    () => ({
      textScale,
      setTextScale: (scale) => setTextScaleState(clampUiScale(scale)),
      iconScale,
      setIconScale: (scale) => setIconScaleState(clampUiScale(scale)),
    }),
    [textScale, iconScale],
  )

  return <UiScaleContext.Provider value={value}>{children}</UiScaleContext.Provider>
}
