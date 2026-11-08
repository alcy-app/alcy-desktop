import type { VersionControlCommandError } from '../bindings/version-control-types'
import type { TranslationKey, TranslationParams } from './i18n/translations'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** User-facing text for a version control command error. */
export function versionControlErrorMessage(error: VersionControlCommandError, t: Translate): string {
  switch (error.kind) {
    case 'unauthorized':
    case 'conflict':
    case 'tooLarge':
    case 'nothingToCommit':
    case 'emptyMessage':
    case 'notLinked':
    case 'cancelled':
    case 'gitIdentityMissing':
    case 'gitMergeInProgress':
    case 'gitNoMergeInProgress':
    case 'gitNoRemote':
    case 'gitNotInstalled':
    case 'gitPushRejected':
    case 'gitDestinationExists':
    case 'gitNotAWorkspace':
      return t(`vc.error.${error.kind}`)
    case 'gitUncommittedChanges':
      return t('vc.error.gitUncommittedChanges', { files: error.files.join(', ') })
    case 'gitInvalidBranch':
      return t('vc.error.gitInvalidBranch', { name: error.name })
    case 'gitInvalidRemote':
      return t('vc.error.gitInvalidRemote', { url: error.url })
    case 'conflicts':
      return t('vc.error.conflicts', { files: error.files.join(', ') })
    case 'incompleteResolution':
      return t('vc.error.incompleteResolution', { file: error.file })
    default:
      return t(`vc.error.${error.kind}`, { message: error.message })
  }
}
