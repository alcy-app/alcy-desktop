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
import { trackUsage } from '../usage-events/track-usage'

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [bindings, setBindings] = useState(readStoredShortcuts)

  useEffect(() => {
    writeStoredShortcuts(bindings)
  }, [bindings])

  const value = useMemo<ShortcutsContextValue>(
    () => ({
      bindings,
      assignShortcut: (action, slot, combo) => {
        setBindings((current) => assignShortcut(current, action, slot, combo))
        trackUsage({ name: 'shortcut_changed', action, change: 'assigned' })
      },
      removeShortcut: (action, slot) => {
        setBindings((current) => removeShortcut(current, action, slot))
        trackUsage({ name: 'shortcut_changed', action, change: 'removed' })
      },
      resetShortcut: (action) => {
        setBindings((current) => resetShortcut(current, action))
        trackUsage({ name: 'shortcut_changed', action, change: 'reset' })
      },
      resetAllShortcuts: () => {
        setBindings(DEFAULT_SHORTCUTS)
        trackUsage({ name: 'shortcut_changed', change: 'resetAll' })
      },
    }),
    [bindings],
  )

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>
}
