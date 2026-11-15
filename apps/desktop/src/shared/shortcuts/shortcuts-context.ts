import { createContext } from 'react'
import type { KeyCombo, ShortcutAction, ShortcutBindings } from './shortcuts'

export interface ShortcutsContextValue {
  bindings: ShortcutBindings
  applyBindings: (bindings: ShortcutBindings) => void
  /** Assign a combo to an action slot, removing it from any conflicting action. */
  assignShortcut: (action: ShortcutAction, slot: number, combo: KeyCombo) => void
  removeShortcut: (action: ShortcutAction, slot: number) => void
  resetShortcut: (action: ShortcutAction) => void
  resetAllShortcuts: () => void
}

export const ShortcutsContext = createContext<ShortcutsContextValue | null>(null)
