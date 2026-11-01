import type { AgentContextKind } from './agent-context'

/** An item another panel asks to mention in the agent chat. */
export interface AgentMentionRequest {
  kind: AgentContextKind
  id: string
  label: string
  /** What the item is, when the workbench cannot look it up by id (a response value). */
  summary?: string
}

// Lives outside React like the editor bridge: item menus anywhere in the
// workbench ask, the workbench opens the agent panel and the composer, once
// mounted, takes the pending requests and writes them into its text.
let pending: AgentMentionRequest[] = []
const listeners = new Set<() => void>()

export function mentionInChat(request: AgentMentionRequest) {
  pending = [...pending, request]
  for (const listener of listeners) listener()
}

/** Requests not handled yet; taking them clears the queue. */
export function takeMentionRequests(): AgentMentionRequest[] {
  const taken = pending
  pending = []
  return taken
}

export function subscribeMentionRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
