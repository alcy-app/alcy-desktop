import type { GitlabCommandError } from '../../bindings/gitlab-types'
import type { TranslationKey, TranslationParams } from '../i18n/translations'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** Texto para o usuário de um erro dos commands de GitLab e de controle de versão. */
export function gitlabErrorMessage(error: GitlabCommandError, t: Translate): string {
  switch (error.kind) {
    case 'unauthorized':
    case 'conflict':
    case 'tooLarge':
    case 'nothingToCommit':
    case 'emptyMessage':
    case 'notLinked':
    case 'accountMissing':
    case 'branchNotWritable':
    case 'timeout':
    case 'cancelled':
      return t(`gitlab.error.${error.kind}`)
    case 'conflicts':
      return t('gitlab.error.conflicts', { files: error.files.join(', ') })
    case 'portBusy':
      return t('gitlab.error.portBusy', { port: error.port })
    case 'incompleteResolution':
      return t('gitlab.error.incompleteResolution', { file: error.file })
    default:
      return t(`gitlab.error.${error.kind}`, { message: error.message })
  }
}
