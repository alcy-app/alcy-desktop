import { invokeResult, type CommandResult } from './invoke-result'

/** A file chosen in the native dialog for a REST body (binary or form-data
 * file field). */
export interface PickedBodyFile {
  /** Relative with `/` inside the workspace; absolute outside it. */
  path: string
  outsideWorkspace: boolean
  sizeBytes: number
}

export type BodyFileCommandError =
  | { kind: 'storage'; message: string }
  | { kind: 'io'; message: string }
  | { kind: 'notGranted' }

/** Opens the native dialog through the backend, which grants a file outside
 * the workspace for this workspace (spec 0163). Only the path comes back:
 * the backend reads the bytes at send time (ADR 0024). `null` when the
 * dialog was cancelled or failed. */
export async function pickBodyFile(rootPath: string, currentPath: string): Promise<PickedBodyFile | null> {
  const result = await invokeResult<PickedBodyFile | null, BodyFileCommandError>('pick_body_file', {
    input: { rootPath, currentPath: currentPath || null },
  })
  return result.ok ? result.value : null
}

/** Copies a file picked for this workspace into its `files/` folder and
 * returns the copy's workspace-relative path. */
export function copyBodyFileIntoWorkspace(
  rootPath: string,
  filePath: string,
): Promise<CommandResult<{ path: string }, BodyFileCommandError>> {
  return invokeResult('copy_body_file_into_workspace', { input: { rootPath, filePath } })
}

/** How many files outside the workspace were picked for it. */
export function countBodyFileGrants(rootPath: string): Promise<CommandResult<number, BodyFileCommandError>> {
  return invokeResult('count_body_file_grants', { input: { rootPath } })
}

/** Forgets the files outside the workspace picked for it. */
export function clearBodyFileGrants(rootPath: string): Promise<CommandResult<null, BodyFileCommandError>> {
  return invokeResult('clear_body_file_grants', { input: { rootPath } })
}
