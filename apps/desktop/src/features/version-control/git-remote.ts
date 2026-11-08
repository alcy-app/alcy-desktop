import { pullGitRemote } from '../../bindings/local-git'
import type { VersionControl } from './use-version-control'

/** Fetches and merges the current branch from `origin`. */
export function pullFromRemote(vc: VersionControl, rootPath: string) {
  return vc.runGit(
    (operationId) => pullGitRemote(rootPath, operationId),
    (result) => result.files,
  )
}
