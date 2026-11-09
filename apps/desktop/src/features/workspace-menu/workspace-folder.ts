/** Paths arrive as the platform wrote them, so both separators are handled. */
const SEPARATOR = /[\\/]/

/** Last segment of a workspace root: the real name of its folder. */
export function folderNameOf(rootPath: string): string {
  return rootPath.split(SEPARATOR).filter(Boolean).pop() ?? rootPath
}

/** The path the root would have with `folderName` as its last segment. */
export function withFolderName(rootPath: string, folderName: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, '')
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return `${trimmed.slice(0, separatorIndex + 1)}${folderName}`
}
