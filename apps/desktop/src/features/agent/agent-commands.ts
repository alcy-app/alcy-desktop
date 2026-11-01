export const AGENT_COMMANDS = ['clear', 'compact'] as const
export type AgentCommand = (typeof AGENT_COMMANDS)[number]

/** Commands occupy the composer; slashes inside prompts, paths and code do not open the menu. */
export function agentCommandQuery(text: string, caret: number): string | null {
  if (caret !== text.length) return null
  return /^[\t ]*\/([a-z]*)$/i.exec(text)?.[1].toLowerCase() ?? null
}

export function parseAgentCommand(text: string): AgentCommand | undefined {
  return AGENT_COMMANDS.find((command) => text.trim().toLowerCase() === `/${command}`)
}
