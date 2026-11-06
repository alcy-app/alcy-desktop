import { useEffect, useState } from 'react'
import type { GitlabCommandError } from '../../bindings/gitlab-types'
import { getGitState, type GitStateDto } from '../../bindings/local-git'

/** Git state of the workspace (branch, branches, pending merge, shared
 * folder), reloaded whenever `reloadKey` changes. Keeps the last state
 * while reloading. */
export function useGitState(rootPath: string, enabled: boolean, reloadKey: string) {
  const [entry, setEntry] = useState<{ state: GitStateDto | null; error: GitlabCommandError | null } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void getGitState(rootPath).then((result) => {
      if (!active) return
      setEntry(result.ok ? { state: result.value, error: null } : { state: null, error: result.error })
    })
    return () => {
      active = false
    }
  }, [enabled, reloadKey, rootPath])
  return entry
}
