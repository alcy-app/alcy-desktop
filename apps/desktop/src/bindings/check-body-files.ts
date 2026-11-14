import { invoke } from '@tauri-apps/api/core'

/** State of a body file: `blocked` is outside the workspace and neither
 * picked for it nor allowed by the security setting (spec 0163);
 * `outsideAllowed` is outside but readable. */
export type BodyFileStatus = 'ok' | 'missing' | 'blocked' | 'outsideAllowed'

/** For each body file path (relative to the workspace or absolute), whether
 * it exists on this machine and whether a send may read it. When the IPC
 * fails, reports every file as fine: better no warning than a wrong one,
 * and the send still refuses a missing or blocked file with a clear error. */
export async function checkBodyFiles(rootPath: string, paths: string[]): Promise<BodyFileStatus[]> {
  if (paths.length === 0) return []
  try {
    return await invoke<BodyFileStatus[]>('check_body_files', { input: { rootPath, paths } })
  } catch {
    return paths.map(() => 'ok')
  }
}
