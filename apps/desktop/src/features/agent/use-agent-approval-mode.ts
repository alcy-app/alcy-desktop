import { useCallback, useState } from 'react'

/** `automatic`: side effects wait for approval (default). `autoApprove`: every action runs without asking. */
export type AgentApprovalMode = 'automatic' | 'autoApprove'

const STORAGE_KEY = 'alcy:agent:approval-mode'

function readMode(): AgentApprovalMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'autoApprove' ? 'autoApprove' : 'automatic'
  } catch {
    return 'automatic'
  }
}

/** The approval mode of the agent panel, remembered on this machine. */
export function useAgentApprovalMode() {
  const [mode, setModeState] = useState<AgentApprovalMode>(readMode)
  const setMode = useCallback((next: AgentApprovalMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage unavailable; the choice lasts for this session only.
    }
  }, [])
  return { mode, setMode }
}
