import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react'

export interface SettingsAction {
  dirty: boolean
  isDefault: boolean
  blocked?: boolean
  invalid?: boolean
  apply: () => boolean | void | Promise<boolean | void>
  restore?: () => void
}

export const SettingsActionsContext = createContext<{
  register: (id: string, action: SettingsAction) => () => void
} | null>(null)

/** Fields retain their drafts while their page coordinates Apply and Restore. */
export function useSettingsAction(action: SettingsAction, enabled = true) {
  const context = useContext(SettingsActionsContext)
  const id = useId()
  const latest = useRef(action)
  useLayoutEffect(() => { latest.current = action })
  const register = context?.register
  const { dirty, isDefault, blocked, invalid } = action
  useLayoutEffect(() => enabled ? register?.(id, {
    dirty, isDefault, blocked, invalid,
    apply: () => latest.current.apply(),
    restore: () => latest.current.restore?.(),
  }) : undefined, [register, id, dirty, isDefault, blocked, invalid, enabled])
}

export function useSettingDraft<T>(saved: T, defaultValue: T, save: (value: T) => boolean | void | Promise<boolean | void>, ready = true, enabled = true) {
  const [draft, setDraft] = useState(saved)
  const [synced, setSynced] = useState(saved)
  if (saved !== synced) {
    setSynced(saved)
    setDraft(saved)
  }
  useSettingsAction({
    dirty: ready && draft !== saved,
    isDefault: draft === defaultValue,
    blocked: !ready,
    apply: () => save(draft),
    restore: () => setDraft(defaultValue),
  }, enabled)
  return [draft, setDraft] as const
}
