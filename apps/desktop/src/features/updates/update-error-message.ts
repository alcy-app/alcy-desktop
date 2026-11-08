import type { UpdateCommandError } from '../../bindings/update-types'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** Texto para o usuário de um erro dos commands de atualização. */
export function updateErrorMessage(error: UpdateCommandError, t: Translate): string {
  switch (error.kind) {
    case 'notConfigured':
    case 'noReleases':
    case 'missingPublicKey':
    case 'notAvailable':
    case 'noPendingUpdate':
    case 'cancelled':
    case 'network':
      // `network`: sem conexão com a origem das atualizações; quando ela fica
      // numa rede privada, a causa mais comum é a VPN desligada.
      return t(`updates.error.${error.kind}`)
    case 'noManifest':
      return t('updates.error.noManifest', { tag: error.tag })
    case 'invalid':
    case 'notFound':
    case 'signature':
    case 'rejected':
    case 'storage':
    case 'backup':
    case 'updater':
      return t(`updates.error.${error.kind}`, { message: error.message })
  }
}
