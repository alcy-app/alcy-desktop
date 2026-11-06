import { syncGitSharedFolder, type GitSyncDto } from '../../bindings/local-git'
import type { useLanguage } from '../../shared/i18n/use-language'
import type { VersionControl } from './use-version-control'

type Translate = ReturnType<typeof useLanguage>['t']

/** What a sync did, in one sentence for the panel. */
export function syncNotice(result: GitSyncDto, t: Translate): string {
  const parts: string[] = []
  if (result.merge) parts.push(t('vc.git.syncMerge', { name: result.merge.label }))
  else if (result.integrated.length > 0) parts.push(t('vc.git.syncIntegrated', { names: result.integrated.join(', ') }))
  else if (result.published) parts.push(t('vc.git.syncPublished'))
  else parts.push(t('vc.git.syncUpToDate'))
  if (result.syncing.length > 0) parts.push(t('vc.git.syncWaiting', { names: result.syncing.join(', ') }))
  return parts.join(' ')
}

/** Publishes this person's work and brings in everyone else's. */
export function syncSharedFolder(vc: VersionControl, rootPath: string, t: Translate) {
  return vc.runGit(
    (operationId) => syncGitSharedFolder(rootPath, operationId),
    (result) => ({ files: result.files, notice: syncNotice(result, t) }),
  )
}
