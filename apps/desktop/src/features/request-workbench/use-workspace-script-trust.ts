import { useCallback, useEffect, useMemo, useState } from 'react'
import { getWorkspaceScriptTrust, setWorkspaceScriptTrust, type WorkspaceScriptTrust } from '../../bindings/script-trust'
import type { TreeNode } from './collection-tree'
import { nodeHasScripts } from './script-trust'

/**
 * This person's decision about the scripts of the open workspace (spec 0162). The question shows
 * once, the first time the workspace has scripts: when it opens with them, or when a pull or a
 * sync brings the first ones. Closing it counts as "do not trust".
 */
export function useWorkspaceScriptTrust(rootPath: string, collections: TreeNode[], collectionsLoaded: boolean) {
  const [state, setState] = useState<{ rootPath: string; trust: WorkspaceScriptTrust } | null>(null)

  useEffect(() => {
    let current = true
    void getWorkspaceScriptTrust(rootPath).then((result) => {
      // An unreadable decision trusts nothing, like the backend.
      if (current) setState({ rootPath, trust: result.ok ? result.value : 'undecided' })
    })
    return () => {
      current = false
    }
  }, [rootPath])

  const trust = state?.rootPath === rootPath ? state.trust : null
  const hasScripts = useMemo(() => collections.some(nodeHasScripts), [collections])

  const decide = useCallback(
    async (trusted: boolean) => {
      const result = await setWorkspaceScriptTrust(rootPath, trusted)
      if (!result.ok) return false
      setState({ rootPath, trust: trusted ? 'trusted' : 'untrusted' })
      return true
    },
    [rootPath],
  )

  return {
    /** `null` while loading. */
    trust,
    /** Ask now: the workspace was never decided and has scripts. */
    shouldAsk: collectionsLoaded && trust === 'undecided' && hasScripts,
    decide,
  }
}
