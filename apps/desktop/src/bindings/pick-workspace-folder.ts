import { pickPath } from './pick-paths'

/** The chosen folder, or `null` when the person cancels. Picked through the
 * backend, which then accepts it as a workspace root (ADR 0081). */
export function pickWorkspaceFolder(): Promise<string | null> {
  return pickPath({ directory: true })
}
