import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  assignShortcut,
  DEFAULT_SHORTCUTS,
  readStoredShortcuts,
  removeShortcut,
  resetShortcut,
  writeStoredShortcuts,
} from './shortcuts'
import { ShortcutsContext, type ShortcutsContextValue } from './shortcuts-context'

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState(readStoredShortcuts)

  useEffect(() => {
    writeStoredShortcuts(bindings)
  }, [bindings])

  const value = useMemo<ShortcutsContextValue>(
    () => ({
      bindings,
      assignShortcut: (action, slot, combo) => setBindings((current) => assignShortcut(current, action, slot, combo)),
      removeShortcut: (action, slot) => setBindings((current) => removeShortcut(current, action, slot)),
      resetShortcut: (action) => setBindings((current) => resetShortcut(current, action)),
      resetAllShortcuts: () => setBindings(DEFAULT_SHORTCUTS),
    }),
    [bindings],
  )

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>
}
