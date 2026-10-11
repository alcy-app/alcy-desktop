import { useContext } from 'react'
import { ShortcutsContext, type ShortcutsContextValue } from './shortcuts-context'

export function useShortcuts(): ShortcutsContextValue {
  const context = useContext(ShortcutsContext)
  if (!context) {
    throw new Error('useShortcuts precisa ser usado dentro de ShortcutsProvider')
  }
  return context
}
