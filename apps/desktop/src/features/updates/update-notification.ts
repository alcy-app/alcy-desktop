import type { ReleaseDto } from '../../bindings/update-types'
import { translate, type Language } from '../../shared/i18n/translations'
import type { AppNotification } from '../notifications/notifications.types'
import type { UpdatePhase } from './update-context'

const LANGUAGES: Language[] = ['pt-BR', 'en']

export function localized(build: (language: Language) => string): Record<Language, string> {
  return Object.fromEntries(LANGUAGES.map((language) => [language, build(language)])) as Record<Language, string>
}

function releaseOf(phase: UpdatePhase): ReleaseDto | null {
  switch (phase.kind) {
    case 'available':
    case 'downloading':
    case 'ready':
    case 'installing':
      return phase.release
    default:
      return null
  }
}

/** Aviso na central de notificações enquanto há versão nova; o id por versão
 * faz cada release aparecer como não lida uma única vez. As notas da release
 * (Markdown, num idioma só) viram os detalhes abertos ao clicar no aviso. */
export function updateNotifications(phase: UpdatePhase, today = new Date()): AppNotification[] {
  const release = releaseOf(phase)
  if (!release) return []

  const date = release.publishedAt?.slice(0, 10) || today.toISOString().slice(0, 10)
  const notes = release.notes?.trim()
  return [
    {
      id: `update:${release.version}`,
      kind: 'update',
      date,
      title: localized((language) => translate(language, 'updates.notification.title', { version: release.version })),
      message: localized((language) =>
        release.webUrl
          ? translate(language, 'updates.notification.messageWithLink', { url: release.webUrl })
          : translate(language, 'updates.notification.message'),
      ),
      ...(notes ? { details: localized(() => notes) } : {}),
    },
  ]
}
