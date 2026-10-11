import { createContext } from 'react'
import type { KeyCombo, ShortcutAction, ShortcutBindings } from './shortcuts'

export interface ShortcutsContextValue {
  bindings: ShortcutBindings
  /** Grava `combo` no `slot` da ação; outra ação que o use perde a combinação. */
  assignShortcut: (action: ShortcutAction, slot: number, combo: KeyCombo) => void
  removeShortcut: (action: ShortcutAction, slot: number) => void
  resetShortcut: (action: ShortcutAction) => void
  resetAllShortcuts: () => void
}

export const ShortcutsContext = createContext<ShortcutsContextValue | null>(null)
