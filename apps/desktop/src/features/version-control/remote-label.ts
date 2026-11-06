import type { WorkspaceLinkDto } from '../../bindings/gitlab-types'

/** Short name of where the workspace syncs: the GitLab branch, or the provider. */
export function remoteLabel(link: WorkspaceLinkDto | null): string {
  if (link === null) return ''
  if (link.provider === 'gitlab') return link.branch
  return link.provider === 'git' ? 'Git' : 'OneDrive'
}

/** Remote location shown in the versioning panel header. */
export function remoteLocation(link: WorkspaceLinkDto): string {
  if (link.provider === 'gitlab') return link.projectPath
  if (link.provider === 'git') return 'Git'
  return link.displayPath
}
