import { Fragment, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { BellIcon, ChevronDownIcon, CloseIcon } from '../../shared/ui/icons'
import { useTooltip } from '../../shared/ui/use-tooltip'
import { parseMessage } from './notification-message'
import { NOTIFICATIONS } from './notifications.data'
import { loadDismissedIds, loadReadIds, saveDismissedIds, saveReadIds } from './notifications-storage'
import { useOpenExternalLink } from './use-open-external-link'
import type { Language } from '../../shared/i18n/translations'
import type { AppNotification } from './notifications.types'
import '../../shared/ui/menu.css'
import './notifications.css'

/*
 * Fallback para quando a animação de saída do card não roda (jsdom): um pouco
 * acima de --duration-slow para o onAnimationEnd chegar primeiro.
 */
const DISMISS_FALLBACK_MS = 300

interface NotificationsButtonProps {
  notifications?: AppNotification[]
  /** Abre a aba de detalhes de uma atualização; sem ele, os cards não abrem nada. */
  onOpenDetails?: (item: AppNotification) => void
}

/** Só atualizações com detalhes no idioma ativo abrem uma aba. */
function hasDetails(item: AppNotification, language: Language): boolean {
  return item.kind === 'update' && Boolean(item.details?.[language]?.trim())
}

/** Sino fixo no fim da barra inferior; abre um popup com anúncios, atualizações e alertas. */
export function NotificationsButton({ notifications = NOTIFICATIONS, onOpenDetails }: NotificationsButtonProps) {
  const { language, t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [readIds, setReadIds] = useState(loadReadIds)
  const [dismissedIds, setDismissedIds] = useState(loadDismissedIds)
  // Dispensados que ainda tocam a animação de saída antes de sair da lista.
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(new Set())
  // Destacados só durante a abertura em que eram novos — ao abrir, todos passam a lidos.
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const sorted = useMemo(
    () =>
      notifications
        .filter((item) => !dismissedIds.includes(item.id) || leavingIds.has(item.id))
        .sort((a, b) => b.date.localeCompare(a.date)),
    [notifications, dismissedIds, leavingIds],
  )
  const unreadIds = notifications
    .filter((item) => !readIds.includes(item.id) && !dismissedIds.includes(item.id))
    .map((item) => item.id)
  const unreadCount = unreadIds.length
  const buttonLabel = unreadCount > 0 ? t('notifications.ariaUnread', { count: unreadCount }) : t('notifications.aria')
  // Com o popup aberto, o tooltip ficaria por cima dele.
  const buttonTooltip = useTooltip(buttonLabel, { side: 'top', enabled: !open })
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(language, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }),
    [language],
  )

  const openPopup = () => {
    setHighlightedIds(new Set(unreadIds))
    setExpandedId(null)
    setLeavingIds(new Set())
    if (unreadCount > 0) {
      const allIds = notifications.map((item) => item.id)
      setReadIds(allIds)
      saveReadIds(allIds)
    }
    setOpen(true)
  }

  const finishLeaving = (id: string) => {
    setLeavingIds((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  // Grava na hora para não depender do fim da animação; o card só sai da lista depois dela.
  const dismiss = (id: string) => {
    if (dismissedIds.includes(id)) return
    // Tira o foco do botão que vai sumir sem fechar o popup: um blur para
    // fora dele o fecharia.
    popupRef.current?.focus()
    const next = [...dismissedIds, id]
    setDismissedIds(next)
    saveDismissedIds(next)
    setLeavingIds((current) => new Set(current).add(id))
    if (expandedId === id) setExpandedId(null)
    window.setTimeout(() => finishLeaving(id), DISMISS_FALLBACK_MS)
  }

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }

  return (
    <div
      className="notifications-host"
      onBlur={closeOnBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          setOpen(false)
          buttonRef.current?.focus()
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="notifications-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={buttonLabel}
        {...buttonTooltip.triggerProps}
        onClick={() => (open ? setOpen(false) : openPopup())}
      >
        <BellIcon size={14} />
        {unreadCount > 0 && <span className="rw-statusbar-count">{unreadCount}</span>}
      </button>
      {buttonTooltip.tooltip}

      {open && (
        <div ref={popupRef} className="notifications-popup" role="dialog" aria-label={t('notifications.title')} tabIndex={-1}>
          <header className="notifications-popup-header">{t('notifications.title')}</header>
          {sorted.length === 0 ? (
            <p className="notifications-empty">{t('notifications.empty')}</p>
          ) : (
            <ul className="notifications-list">
              {sorted.map((item) => (
                <li
                  key={item.id}
                  className="notifications-item"
                  data-leaving={leavingIds.has(item.id)}
                  aria-hidden={leavingIds.has(item.id) || undefined}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) finishLeaving(item.id)
                  }}
                >
                  <NotificationCard
                    item={item}
                    language={language}
                    kindLabel={t(`notifications.kind.${item.kind}`)}
                    unreadLabel={highlightedIds.has(item.id) ? t('notifications.unread') : null}
                    date={dateFormat.format(new Date(item.date))}
                    expanded={expandedId === item.id}
                    onToggle={() => setExpandedId((current) => (current === item.id ? null : item.id))}
                    onDismiss={() => dismiss(item.id)}
                    onOpenDetails={
                      onOpenDetails && hasDetails(item, language)
                        ? () => {
                            setOpen(false)
                            onOpenDetails(item)
                          }
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

interface NotificationCardProps {
  item: AppNotification
  language: Language
  kindLabel: string
  unreadLabel: string | null
  date: string
  expanded: boolean
  onToggle: () => void
  /** Dispensa o aviso: ele sai da lista com animação e não volta a aparecer. */
  onDismiss: () => void
  /** Presente quando o card abre uma aba de detalhes: o clique no card passa a abri-la. */
  onOpenDetails?: () => void
}

/**
 * Só oferece expansão quando a mensagem não cabe nas duas linhas do card
 * recolhido. Com detalhes, clicar no card abre a aba deles e a expansão fica
 * só na seta.
 */
function NotificationCard({
  item,
  language,
  kindLabel,
  unreadLabel,
  date,
  expanded,
  onToggle,
  onDismiss,
  onOpenDetails,
}: NotificationCardProps) {
  const { t } = useLanguage()
  const openLink = useOpenExternalLink()
  const messageRef = useRef<HTMLSpanElement>(null)
  const [overflows, setOverflows] = useState(false)
  const title = item.title[language]
  const toggleTooltip = useTooltip(t('notifications.toggle', { title }))
  const dismissTooltip = useTooltip(t('notifications.dismiss'))
  const message = item.message[language]
  const segments = useMemo(() => parseMessage(message), [message])
  // Recolhido, links podem estar escondidos pelo corte: o teclado chega a eles depois de expandir.
  const linkTabIndex = overflows && !expanded ? -1 : undefined

  // Mede com o corte de duas linhas aplicado; expandido, mantém a última medição.
  useLayoutEffect(() => {
    const element = messageRef.current
    if (!element || expanded) return
    setOverflows(element.scrollHeight > element.clientHeight + 1)
  }, [message, expanded])

  return (
    <div
      className="notifications-card"
      data-kind={item.kind}
      data-unread={unreadLabel !== null}
      data-expandable={overflows}
      data-expanded={overflows && expanded}
      data-opens-details={onOpenDetails !== undefined}
      onClick={onOpenDetails ?? (overflows ? onToggle : undefined)}
    >
      <span className="notifications-card-meta">
        <span className="notifications-card-kind">{kindLabel}</span>
        <time dateTime={item.date}>{date}</time>
        <span className="notifications-card-end">
          {unreadLabel !== null && <span className="notifications-card-unread" aria-label={unreadLabel} role="img" />}
          {overflows && (
            <button
              type="button"
              className="notifications-card-toggle"
              aria-expanded={expanded}
              aria-label={t('notifications.toggle', { title })}
              {...toggleTooltip.triggerProps}
              onClick={(event) => {
                event.stopPropagation()
                onToggle()
              }}
            >
              <ChevronDownIcon size={11} className="notifications-card-chevron" />
            </button>
          )}
          {overflows && toggleTooltip.tooltip}
          <button
            type="button"
            className="notifications-card-dismiss"
            aria-label={t('notifications.dismissAria', { title })}
            {...dismissTooltip.triggerProps}
            onClick={(event) => {
              event.stopPropagation()
              onDismiss()
            }}
          >
            <CloseIcon size={11} />
          </button>
          {dismissTooltip.tooltip}
        </span>
      </span>
      <span className="notifications-card-title">{title}</span>
      <span ref={messageRef} className="notifications-card-message">
        {segments.map((segment, index) =>
          segment.type === 'text' ? (
            <Fragment key={index}>{segment.text}</Fragment>
          ) : (
            <a
              key={index}
              href={segment.url}
              title={segment.url}
              className="notifications-card-link"
              tabIndex={linkTabIndex}
              onClick={(event) => openLink(event, segment.url)}
              onAuxClick={(event) => openLink(event, segment.url)}
            >
              {segment.text}
            </a>
          ),
        )}
      </span>
      {onOpenDetails && (
        <button
          type="button"
          className="notifications-card-details"
          aria-label={t('notifications.openDetailsAria', { title })}
          onClick={(event) => {
            event.stopPropagation()
            onOpenDetails()
          }}
        >
          {t('notifications.openDetails')}
        </button>
      )}
    </div>
  )
}
