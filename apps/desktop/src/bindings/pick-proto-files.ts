import { pickPath, pickPaths } from './pick-paths'

/** Chooses `.proto` files for a gRPC request (spec 0129). Only the paths
 * come back; the backend reads and compiles the files. */
export function pickProtoFiles(): Promise<string[]> {
  return pickPaths({ multiple: true, filters: [{ name: 'Protocol Buffers', extensions: ['proto'] }] })
}

/** Chooses a folder searched for the `.proto` files' imports. */
export function pickProtoImportFolder(): Promise<string | null> {
  return pickPath({ directory: true })
}
