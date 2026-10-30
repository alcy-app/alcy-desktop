import type { WorkbenchAgentHost } from './agent-host'
import { savedRequests } from './agent-context'

/** Workspace items the agent can link in its replies as `[name](alcy://<kind>/<id>)`. */
export const AGENT_REFERENCE_KINDS = ['request', 'flow', 'mock', 'tab'] as const
export type AgentReferenceKind = (typeof AGENT_REFERENCE_KINDS)[number]

export function isAgentReferenceKind(kind: string): kind is AgentReferenceKind {
  return (AGENT_REFERENCE_KINDS as readonly string[]).includes(kind)
}

/** Opens (or focuses) the tab of a linked item; false when it no longer exists. */
export async function openAgentReference(host: WorkbenchAgentHost, kind: AgentReferenceKind, id: string): Promise<boolean> {
  try {
    switch (kind) {
      case 'request':
        return (await host.openRequest(id)) !== null
      case 'tab':
        return await host.selectTab(id)
      case 'flow':
        return (await host.resources?.call('open_flow', { flowId: id }))?.isError === false
      case 'mock':
        return (await host.resources?.call('open_mock_server', { serverId: id }))?.isError === false
    }
  } catch {
    return false
  }
}

/**
 * Finds the workspace item a bolded or code-formatted word of a reply names,
 * by id or by a name only one request, flow or mock has. Models often name
 * items this way instead of linking them.
 */
export function agentReferenceResolver(host: WorkbenchAgentHost): (text: string) => { kind: AgentReferenceKind; id: string } | null {
  const items = [
    ...savedRequests(host.collections()),
    ...(host.resources?.context() ?? []).filter((item) => item.kind === 'flow' || item.kind === 'mock'),
  ] as { kind: AgentReferenceKind; id: string; label: string }[]
  const byId = new Map(items.map((item) => [item.id, item]))
  const byName = new Map<string, { kind: AgentReferenceKind; id: string }[]>()
  for (const item of items) {
    const name = item.label.trim().toLowerCase()
    if (name) byName.set(name, [...(byName.get(name) ?? []), item])
  }
  return (text) => {
    const key = text.trim()
    const found = byId.get(key) ?? (byName.get(key.toLowerCase())?.length === 1 ? byName.get(key.toLowerCase())?.[0] : undefined)
    return found ? { kind: found.kind, id: found.id } : null
  }
}
