import { createContext } from 'react'

export interface UiScaleContextValue {
  textScale: number
  setTextScale: (scale: number) => void
  iconScale: number
  setIconScale: (scale: number) => void
}

export const UiScaleContext = createContext<UiScaleContextValue | null>(null)
