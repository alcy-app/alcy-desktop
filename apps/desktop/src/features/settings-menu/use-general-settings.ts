import { useEffect, useRef, useState } from 'react'
import { getGeneralSettings, type GeneralSettingsDto } from '../../bindings/get-general-settings'
import { saveGeneralSettings } from '../../bindings/save-general-settings'

/** One snapshot per modal; serialize patches because the native command saves the whole DTO. */
export function useGeneralSettings() {
  const [saved, setSaved] = useState<GeneralSettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const latest = useRef<GeneralSettingsDto | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    void getGeneralSettings().then((result) => {
      if (cancelled) return
      if (result.ok) {
        latest.current = result.value
        setSaved(result.value)
      } else setLoadError(result.error.message)
    })
    return () => { cancelled = true }
  }, [])

  const save = (patch: Partial<GeneralSettingsDto>) => {
    const operation = queue.current.then(async () => {
      if (latest.current === null) return { ok: false as const, message: '' }
      const result = await saveGeneralSettings({ ...latest.current, ...patch })
      if (!result.ok) return { ok: false as const, message: result.error.message }
      latest.current = result.value
      setSaved(result.value)
      return { ok: true as const }
    })
    queue.current = operation.catch(() => undefined)
    return operation
  }
  return { saved, loadError, save }
}

export type GeneralSettingsState = ReturnType<typeof useGeneralSettings>
