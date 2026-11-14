import { invoke } from '@tauri-apps/api/core'

export interface PickFilter {
  name: string
  extensions: string[]
}

export interface PickPathsOptions {
  /** Pick folders instead of files. */
  directory?: boolean
  multiple?: boolean
  filters?: PickFilter[]
}

/** Opens the native open dialog through the backend, which remembers what
 * the person picked: commands that read a user file only accept paths picked
 * here or dropped on the window (ADR 0081). Empty when cancelled. */
export async function pickPaths(options: PickPathsOptions): Promise<string[]> {
  try {
    return await invoke<string[]>('pick_paths', {
      input: { directory: options.directory ?? false, multiple: options.multiple ?? false, filters: options.filters ?? [] },
    })
  } catch {
    return []
  }
}

/** One path, or `null` when cancelled. */
export async function pickPath(options: Omit<PickPathsOptions, 'multiple'>): Promise<string | null> {
  const [path] = await pickPaths({ ...options, multiple: false })
  return path ?? null
}
