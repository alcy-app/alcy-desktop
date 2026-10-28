import type { WorkspaceLinkDto } from '../../bindings/gitlab-types'

/** Short name of where the workspace syncs: the GitLab branch, or the provider. */
export function remoteLabel(link: WorkspaceLinkDto | null): string {
  if (link === null) return ''
  return link.provider === 'gitlab' ? link.branch : 'OneDrive'
}

/** Remote location shown in the versioning panel header. */
export function remoteLocation(link: WorkspaceLinkDto): string {
  return link.provider === 'gitlab' ? link.projectPath : link.displayPath
}
