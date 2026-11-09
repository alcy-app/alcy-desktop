import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { getWorkspaceFileStamps } from '../../bindings/get-workspace-file-stamps'

export const COLLECTIONS_FILE = 'alcy-collections.json'
export const ENVIRONMENTS_FILE = 'alcy-environments.json'
export const FLOWS_FILE = 'alcy-flows.json'

const CHECK_INTERVAL_MS = 5_000

/**
 * Notices workspace files changed outside Alcy, as when a folder is shared
 * through a sync tool. A file with an edit still waiting for its autosave is
 * left for a later check, so reloading never discards that edit.
 */
export function useExternalFileChanges(
  rootPath: string,
  hasPendingSave: (name: string) => boolean,
  onChanged: (names: string[]) => void,
) {
  const knownRef = useRef<Map<string, string> | null>(null)
  const callbacksRef = useRef({ hasPendingSave, onChanged })
  useLayoutEffect(() => {
    callbacksRef.current = { hasPendingSave, onChanged }
  })

  /** Alcy just wrote `name`: its new stamp is not somebody else's change. */
  const markOwnWrite = useCallback(
    (name: string) => {
      void getWorkspaceFileStamps(rootPath).then((result) => {
        if (!result.ok || knownRef.current === null) return
        const stamp = result.value.find((file) => file.name === name)?.stamp
        if (stamp === undefined) knownRef.current.delete(name)
        else knownRef.current.set(name, stamp)
      })
    },
    [rootPath],
  )

  useEffect(() => {
    let cancelled = false
    let checking = false
    knownRef.current = null

    const check = async () => {
      if (checking || document.hidden) return
      checking = true
      const result = await getWorkspaceFileStamps(rootPath)
      checking = false
      if (cancelled || !result.ok) return

      const current = new Map(result.value.map((file) => [file.name, file.stamp]))
      const known = knownRef.current
      if (known === null) {
        knownRef.current = current
        return
      }

      const changed = [...new Set([...known.keys(), ...current.keys()])].filter(
        (name) => known.get(name) !== current.get(name) && !callbacksRef.current.hasPendingSave(name),
      )
      if (changed.length === 0) return
      for (const name of changed) {
        const stamp = current.get(name)
        if (stamp === undefined) known.delete(name)
        else known.set(name, stamp)
      }
      callbacksRef.current.onChanged(changed)
    }

    void check()
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [rootPath])

  return { markOwnWrite }
}
