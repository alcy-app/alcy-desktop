import { useRef, useState } from 'react'
import type { FocusEvent, MouseEvent } from 'react'
import type { RequestSendDto } from '../../../bindings/list-request-sends'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { ChevronDownIcon, ClockIcon, EllipsisIcon } from '../../../shared/ui/icons'
import { MenuItem, OptionsMenu } from '../../../shared/ui/Menu'
import type { SendsState } from '../use-send-history'
import { OutcomeText } from './ResponseComparisonView'
import { RequestMethodBadge } from './RequestMethodBadge'
import { VirtualizedList } from './VirtualizedList'
import './response-history.css'

/** O que o painel de resposta mostra: a resposta atual, a de um envio anterior ou a comparação entre dois envios. */
export type ResponseView =
  | { kind: 'current' }
  | { kind: 'past'; sendId: string }
  | { kind: 'compare'; firstId: string; secondId: string }

interface ResponseHistoryMenuProps {
  sends: SendsState
  currentSendId: string | null
  view: ResponseView
  /** Chamado ao abrir o menu — é quando a lista de envios é (re)carregada. */
  onOpen: () => void
  onShowCurrent: () => void
  onShowPast: (sendId: string) => void
  onCompare: (firstId: string, secondId: string) => void
  onChangeBaseline: (sendId: string | null) => void
  formatTime: (send: RequestSendDto) => string
}

/** Posição (relativa ao painel do menu) da linha sob o card lateral. */
interface RowAnchor {
  sendId: string
  top: number
  /** Lado do menu em que o card abre: à direita, ou à esquerda quando não cabe na janela. */
  side: 'right' | 'left'
}

/** Altura fixa de cada linha; a lista mostra no máximo 5 (ver `.rw-history-list`). */
const ROW_HEIGHT_PX = 32
/** Altura aproximada do menu aberto; abaixo disso de espaço até a borda da janela, ele abre para cima. */
const MENU_HEIGHT_PX = 340
/** Largura do card lateral mais o espaçamento até o menu. */
const SIDE_CARD_SPACE_PX = 280

/** Botão "Histórico" da barra da resposta: lista a resposta atual e os envios anteriores da requisição. */
export function ResponseHistoryMenu({
  sends,
  currentSendId,
  view,
  onOpen,
  onShowCurrent,
  onShowPast,
  onCompare,
  onChangeBaseline,
  formatTime,
}: ResponseHistoryMenuProps) {
  const { t } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const [hovered, setHovered] = useState<RowAnchor | null>(null)
  const [actionsFor, setActionsFor] = useState<RowAnchor | null>(null)
  const [openUp, setOpenUp] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)

  const list = sends.status === 'ready' ? sends.sends : []
  const current = list.find((send) => send.id === currentSendId) ?? null
  const baseline = list.find((send) => send.baseline) ?? null
  const past = list.filter((send) => send.id !== currentSendId)
  const viewedPast = view.kind === 'past' ? (list.find((send) => send.id === view.sendId) ?? null) : null

  const close = () => {
    setIsOpen(false)
    setHovered(null)
    setActionsFor(null)
  }

  const anchorOf = (sendId: string, row: HTMLElement): RowAnchor => {
    const panel = panelRef.current?.getBoundingClientRect()
    const fitsRight = !panel || panel.right + SIDE_CARD_SPACE_PX <= window.innerWidth
    return { sendId, top: row.getBoundingClientRect().top - (panel?.top ?? 0), side: fitsRight ? 'right' : 'left' }
  }

  const triggerLabel =
    view.kind === 'compare' ? t('responseHistory.comparing') : viewedPast ? formatTime(viewedPast) : t('responseHistory.trigger')

  const renderRow = (send: RequestSendDto | null) => {
    const id = send?.id ?? null
    const isCurrentRow = send === null || send.id === currentSendId
    const active = isCurrentRow ? view.kind === 'current' : view.kind === 'past' && view.sendId === id

    const onRowPointer = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
      if (send) setHovered(anchorOf(send.id, event.currentTarget))
    }

    const openActions = (row: HTMLElement) => {
      if (!send) return
      setHovered(null)
      setActionsFor((open) => (open?.sendId === send.id ? null : anchorOf(send.id, row)))
    }

    return (
      <div
        className={active ? 'rw-history-row rw-history-row--active' : 'rw-history-row'}
        onMouseEnter={onRowPointer}
        onMouseLeave={() => setHovered(null)}
        onFocus={onRowPointer}
        onContextMenu={(event) => {
          if (!send) return
          event.preventDefault()
          openActions(event.currentTarget)
        }}
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked={active}
          className="rw-history-row-main"
          onClick={() => {
            if (isCurrentRow) onShowCurrent()
            else if (id !== null) onShowPast(id)
            close()
          }}
        >
          <span className="rw-history-row-time">{isCurrentRow || send === null ? t('responseHistory.current') : formatTime(send)}</span>
          {send && <OutcomeText outcome={send.outcome} />}
          {send?.baseline && <Badge tone="accent">{t('responseHistory.baseline')}</Badge>}
        </button>
        {send && (
          <button
            type="button"
            className="ui-icon-button rw-history-row-more"
            aria-label={t('responseHistory.actionsAria', { time: formatTime(send) })}
            aria-haspopup="true"
            aria-expanded={actionsFor?.sendId === send.id}
            onClick={(event) => {
              const row = event.currentTarget.parentElement
              if (!row) return
              openActions(row)
            }}
          >
            <EllipsisIcon size={12} />
          </button>
        )}
      </div>
    )
  }

  const actionsSend = actionsFor ? (list.find((send) => send.id === actionsFor.sendId) ?? null) : null
  const hoveredSend = !actionsFor && hovered ? (list.find((send) => send.id === hovered.sendId) ?? null) : null

  return (
    <div ref={anchorRef} className="rw-history-anchor">
    <OptionsMenu
      label={t('responseHistory.aria')}
      isOpen={isOpen}
      onToggle={() => {
        if (!isOpen) {
          onOpen()
          const bottom = anchorRef.current?.getBoundingClientRect().bottom ?? 0
          setOpenUp(bottom + MENU_HEIGHT_PX > window.innerHeight && bottom > MENU_HEIGHT_PX)
        }
        setIsOpen(!isOpen)
      }}
      onClose={close}
      wrapperClassName="rw-history-host"
      buttonClassName="rw-history-trigger"
      menuClassName={openUp ? 'rw-history-menu rw-history-menu--up' : 'rw-history-menu'}
      icon={
        <>
          <ClockIcon size={14} />
          <span className="rw-history-trigger-label">{triggerLabel}</span>
          <ChevronDownIcon size={12} />
        </>
      }
    >
      <div
        ref={panelRef}
        className="rw-history-panel"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && actionsFor) {
            event.stopPropagation()
            setActionsFor(null)
          }
        }}
      >
        {sends.status === 'loading' && <p className="rw-history-message">{t('responseHistory.loading')}</p>}
        {sends.status === 'error' && <p className="rw-history-message">{t('responseHistory.loadError')}</p>}
        {sends.status === 'ready' && (
          <>
            {renderRow(current)}
            {past.length === 0 ? (
              <p className="rw-history-message">{t('responseHistory.empty')}</p>
            ) : (
              <VirtualizedList
                className="virtual-list rw-history-list"
                ariaLabel={t('responseHistory.listAria')}
                items={past}
                getKey={(send) => send.id}
                estimatedRowHeight={ROW_HEIGHT_PX}
                renderItem={renderRow}
              />
            )}
          </>
        )}

        {hoveredSend && hovered && (
          <div className={`rw-history-card rw-history-side--${hovered.side}`} style={{ top: hovered.top }} aria-hidden="true">
            {hoveredSend.method && <RequestMethodBadge protocol={hoveredSend.protocol} method={hoveredSend.method} />}
            <span className="rw-history-card-url">{hoveredSend.endpoint}</span>
          </div>
        )}

        {actionsSend && actionsFor && (
          <div className={`ui-menu rw-history-actions rw-history-side--${actionsFor.side}`} role="menu" aria-label={t('responseHistory.actionsAria', { time: formatTime(actionsSend) })} style={{ top: actionsFor.top }}>
            {current && actionsSend.id !== current.id && (
              <MenuItem
                label={t('responseHistory.compareWithCurrent')}
                autoFocus
                onSelect={() => {
                  onCompare(actionsSend.id, current.id)
                  close()
                }}
              />
            )}
            {baseline && actionsSend.id !== baseline.id && (
              <MenuItem
                label={t('responseHistory.compareWithBaseline')}
                onSelect={() => {
                  onCompare(baseline.id, actionsSend.id)
                  close()
                }}
              />
            )}
            <MenuItem
              label={actionsSend.baseline ? t('responseHistory.clearBaseline') : t('responseHistory.setBaseline')}
              onSelect={() => {
                onChangeBaseline(actionsSend.baseline ? null : actionsSend.id)
                setActionsFor(null)
              }}
            />
          </div>
        )}
      </div>
    </OptionsMenu>
    </div>
  )
}

