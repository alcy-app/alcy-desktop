import { useId, useMemo, useState } from 'react'
import type { WebSocketEventDto } from '../../../bindings/execute-websocket-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Input } from '../../../shared/ui/Input'
import { Select } from '../../../shared/ui/Select'
import { ChevronDownIcon } from '../../../shared/ui/icons'
import { formatSize } from '../response-summary'
import type { WebSocketStreamState } from '../websocket-stream'
import { ResponseCodeView } from './ResponseCodeView'
import { ResponseHeadersList } from './ResponseHeadersList'
import { VirtualizedList } from './VirtualizedList'
import './grpc.css'
import './websocket.css'

type Direction = 'all' | 'sent' | 'received'

function isJson(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Messages of a connection, newest first, in variable-height virtual rows so
 * long sessions stay responsive (spec 0140). */
export function WebSocketTimeline({ stream }: { stream: WebSocketStreamState }) {
  const { t, language } = useLanguage()
  const id = useId()
  const [query, setQuery] = useState('')
  const [direction, setDirection] = useState<Direction>('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
      }),
    [language],
  )
  const events = useMemo(
    () => stream.events.map((event, index) => ({ event, key: stream.dropped + index })).reverse(),
    [stream.events, stream.dropped],
  )
  const search = query.trim().toLocaleLowerCase(language)
  const describe = (event: WebSocketEventDto): string => {
    switch (event.type) {
      case 'message':
        return event.data
      case 'opened':
        return t('websocket.event.opened') + (event.subprotocol ? ' · ' + event.subprotocol : '')
      case 'closed':
        return (
          t(`websocket.closedBy.${event.closedBy}`) +
          (event.code !== null ? ' · ' + event.code : '') +
          (event.reason ? ': ' + event.reason : '')
        )
    }
  }
  const rows = events.filter(({ event }) => {
    if (direction !== 'all' && (event.type !== 'message' || event.direction !== direction)) return false
    return !search || describe(event).toLocaleLowerCase(language).includes(search)
  })

  return (
    <div className="rw-grpc-timeline">
      <div className="rw-grpc-timeline-toolbar">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('websocket.searchMessages')}
          placeholder={t('websocket.searchMessages')}
        />
        <Select
          aria-label={t('websocket.messageDirection')}
          value={direction}
          onChange={(event) => setDirection(event.target.value as Direction)}
        >
          <option value="all">{t('websocket.allMessages')}</option>
          <option value="received">{t('websocket.receivedMessages')}</option>
          <option value="sent">{t('websocket.sentMessages')}</option>
        </Select>
      </div>
      {stream.dropped > 0 && (
        <p className="rw-grpc-timeline-notice" role="note">
          {t('websocket.eventsDropped', { count: stream.dropped })}
        </p>
      )}
      {rows.length === 0 && (
        <p className="rw-grpc-timeline-notice" role="status">
          {t(stream.status === 'connecting' ? 'websocket.status.connecting' : 'websocket.noMessages')}
        </p>
      )}
      <VirtualizedList
        items={rows}
        getKey={(item) => String(item.key)}
        estimatedRowHeight={36}
        className="rw-grpc-timeline-viewport"
        ariaLabel={t('websocket.timeline')}
        renderItem={({ event, key }) => {
          const open = expanded === key
          const label =
            event.type === 'message'
              ? t(`websocket.event.${event.direction}`) + ' #' + (event.index + 1)
              : t(`websocket.event.${event.type}`)
          const elapsed = event.elapsedMs
          const timestamp = stream.startedAt ? time.format(stream.startedAt + elapsed) : '+' + elapsed + ' ms'
          const preview =
            event.type === 'message'
              ? (event.format === 'binary' ? '[' + t('websocket.format.binary') + '] ' : '') +
                event.data.replace(/\s+/g, ' ').slice(0, 200)
              : describe(event)
          const failed =
            event.type === 'closed' &&
            (event.closedBy === 'transport' || (event.code !== null && event.code !== 1000 && event.code !== 1001))
          const detailId = id + '-' + key
          const json = event.type === 'message' && event.format === 'text' && isJson(event.data)
          return (
            <div
              className={
                'rw-grpc-event rw-websocket-event--' +
                (event.type === 'message' ? `${event.direction} rw-grpc-event--${event.direction}` : event.type) +
                (failed ? ' rw-websocket-event--error' : '')
              }
            >
              <button
                type="button"
                className="rw-grpc-timeline-row"
                aria-label={label + ' · ' + timestamp}
                aria-expanded={open}
                aria-controls={detailId}
                onClick={() => setExpanded(open ? null : key)}
              >
                <span className="rw-grpc-event-direction" aria-hidden="true">
                  {event.type === 'message' ? (event.direction === 'sent' ? '↑' : '↓') : '○'}
                </span>
                <span className={'rw-grpc-event-preview' + (json ? ' rw-grpc-event-preview--json' : '')}>{preview}</span>
                <span className="rw-grpc-event-size">{event.type === 'message' ? formatSize(event.sizeBytes) : ''}</span>
                <time
                  className="rw-grpc-event-time"
                  dateTime={stream.startedAt ? new Date(stream.startedAt + elapsed).toISOString() : undefined}
                >
                  {timestamp}
                </time>
                <span className={'rw-grpc-event-chevron' + (open ? ' rw-grpc-event-chevron--open' : '')}>
                  <ChevronDownIcon size={12} />
                </span>
              </button>
              {open && (
                <div className="rw-grpc-event-detail" id={detailId} role="region" aria-label={label}>
                  {event.type === 'message' ? (
                    <>
                      {event.truncated && <p role="note">{t('websocket.messageTruncated')}</p>}
                      <ResponseCodeView
                        text={event.data}
                        language={json ? 'json' : 'none'}
                        partial={event.truncated}
                      />
                    </>
                  ) : event.type === 'opened' ? (
                    <ResponseHeadersList headers={event.headers} />
                  ) : (
                    <p>{describe(event)}</p>
                  )}
                </div>
              )}
            </div>
          )
        }}
      />
    </div>
  )
}
