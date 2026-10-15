import { open } from '@tauri-apps/plugin-dialog'

/** Chooses `.proto` files for a gRPC request (spec 0129). Only the paths
 * come back; the backend reads and compiles the files. */
export async function pickProtoFiles(): Promise<string[]> {
  const selected = await open({ directory: false, multiple: true, filters: [{ name: 'Protocol Buffers', extensions: ['proto'] }] })
  if (selected === null) return []
  return typeof selected === 'string' ? [selected] : selected
}

/** Chooses a folder searched for the `.proto` files' imports. */
export async function pickProtoImportFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false })
  if (selected === null) return null
  return typeof selected === 'string' ? selected : (selected[0] ?? null)
}
