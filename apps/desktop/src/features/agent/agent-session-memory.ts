/** The chat last open in each workspace during this run of the app, so that
 * switching workspaces or closing and reopening the panel brings it back. It
 * lives only in memory: starting the app again begins with a new chat. */
const remembered = new Map<string, string>()
/** Workspaces remembered; the least recently used fall off. */
const MAX_WORKSPACES = 50

export function rememberedSession(rootPath: string): string | null {
  return remembered.get(rootPath) ?? null
}

/** `null` forgets the workspace's chat (a new chat was started). */
export function rememberSession(rootPath: string, sessionId: string | null) {
  remembered.delete(rootPath)
  if (sessionId === null) return
  // Insertion order tracks recency: the workspace goes last, the oldest are dropped.
  remembered.set(rootPath, sessionId)
  while (remembered.size > MAX_WORKSPACES) {
    const oldest = remembered.keys().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
}

/** Drops every remembered chat, as when the app starts again. Tests use it
 * to isolate each run. */
export function forgetRememberedSessions() {
  remembered.clear()
}
