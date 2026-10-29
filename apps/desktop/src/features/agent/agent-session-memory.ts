/** The chat last open in each workspace, so reopening the app or switching
 * workspaces brings it back. Kept on this machine only; a missing or
 * unreadable entry just starts a new chat. */
const STORAGE_KEY = 'alcy:agent:sessions'
/** Workspaces remembered; the least recently used fall off. */
const MAX_WORKSPACES = 50

type Remembered = Record<string, string>

function read(): Remembered {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

function write(remembered: Remembered) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(remembered))
  } catch {
    // Storage unavailable: the chat is not restored next time, nothing else changes.
  }
}

export function rememberedSession(rootPath: string): string | null {
  return read()[rootPath] ?? null
}

/** `null` forgets the workspace's chat (a new chat was started). */
export function rememberSession(rootPath: string, sessionId: string | null) {
  const others = read()
  delete others[rootPath]
  if (sessionId === null) {
    write(others)
    return
  }
  // Insertion order tracks recency: the workspace goes last, the oldest are dropped.
  const entries = [...Object.entries(others), [rootPath, sessionId] as const]
  write(Object.fromEntries(entries.slice(-MAX_WORKSPACES)))
}
