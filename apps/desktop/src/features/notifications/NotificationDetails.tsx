import { useMemo } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { MarkdownView } from './MarkdownView'
import type { AppNotification } from './notifications.types'
import './notification-details.css'

interface NotificationDetailsProps {
  notification: AppNotification
}

/** Conteúdo da aba aberta ao clicar numa notificação com detalhes (ex.: notas de uma atualização). */
export function NotificationDetails({ notification }: NotificationDetailsProps) {
  const { language, t } = useLanguage()
  // Sem data válida (ex.: versão do changelog sem data), a linha mostra só o tipo.
  const date = useMemo(() => {
    const parsed = new Date(notification.date)
    if (Number.isNaN(parsed.getTime())) return null
    return new Intl.DateTimeFormat(language, { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parsed)
  }, [language, notification.date])

  return (
    <article className="notification-details" data-kind={notification.kind}>
      <div className="notification-details-content">
        <header className="notification-details-header">
          <span className="notification-details-meta">
            <span className="notification-details-kind">{t(`notifications.kind.${notification.kind}`)}</span>
            {date && <time dateTime={notification.date}>{date}</time>}
          </span>
          <h1>{notification.title[language]}</h1>
        </header>
        <MarkdownView source={notification.details?.[language] ?? ''} headingOffset={1} />
      </div>
    </article>
  )
}
