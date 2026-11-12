import { useEffect, useState } from 'react'
import { getSecuritySettings, type SecuritySettingsDto } from '../../bindings/get-security-settings'

const CHANGED_EVENT = 'alcy:security-settings-changed'

/** Tells open screens that the security settings were saved. */
export function notifySecuritySettingsChanged(settings: SecuritySettingsDto) {
  window.dispatchEvent(new CustomEvent<SecuritySettingsDto>(CHANGED_EVENT, { detail: settings }))
}

/** Whether sensitive values go to version control in plain text, following
 * every later save. `false` (the default protection) until the backend
 * answers, and when it cannot. */
export function useSyncSensitiveValues(): boolean {
  const [syncSensitiveValues, setSyncSensitiveValues] = useState(false)

  useEffect(() => {
    let cancelled = false
    let changed = false
    const onChanged = (event: Event) => {
      changed = true
      if (event instanceof CustomEvent) setSyncSensitiveValues((event.detail as SecuritySettingsDto).syncSensitiveValues)
    }
    window.addEventListener(CHANGED_EVENT, onChanged)
    void getSecuritySettings().then((result) => {
      // A save that lands while loading is newer than this read.
      if (!cancelled && !changed && result.ok) setSyncSensitiveValues(result.value.syncSensitiveValues)
    })
    return () => {
      cancelled = true
      window.removeEventListener(CHANGED_EVENT, onChanged)
    }
  }, [])

  return syncSensitiveValues
}
