import { useContext } from 'react'
import { UiScaleContext, type UiScaleContextValue } from './ui-scale-context'

export function useUiScale(): UiScaleContextValue {
  const context = useContext(UiScaleContext)
  if (!context) {
    throw new Error('useUiScale precisa ser usado dentro de UiScaleProvider')
  }
  return context
}
