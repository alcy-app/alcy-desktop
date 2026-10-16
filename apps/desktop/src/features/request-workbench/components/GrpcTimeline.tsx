import { useId, useMemo, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Input } from '../../../shared/ui/Input'
import { Select } from '../../../shared/ui/Select'
import { CheckIcon, ChevronDownIcon } from '../../../shared/ui/icons'
import type { GrpcStreamState } from '../grpc-stream'
import { formatSize } from '../response-summary'
import { ResponseCodeView } from './ResponseCodeView'
import { ResponseHeadersList } from './ResponseHeadersList'
import { VirtualizedList } from './VirtualizedList'
import './grpc.css'

type Direction = 'all' | 'sent' | 'received'

/** Variable-height virtual rows keep expanded messages and long streams bounded. */
export function GrpcTimeline({ stream, pending = false }: { stream: GrpcStreamState; pending?: boolean }) {
  const { t, language } = useLanguage()
  const id = useId()
  const [query, setQuery] = useState('')
  const [direction, setDirection] = useState<Direction>('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const time = useMemo(() => new Intl.DateTimeFormat(language, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
  }), [language])
  const events = useMemo(() => stream.events.map((event, index) => ({ event, key: stream.dropped + index })).reverse(), [stream.events, stream.dropped])
  const search = query.trim().toLocaleLowerCase(language)
  const rows = events.filter(({ event }) => {
    if (direction !== 'all' && event.type !== direction) return false
    const text = 'json' in event ? event.json : event.type === 'finished'
      ? event.status.codeName + ' ' + event.status.message : t(`grpc.event.${event.type}`)
    return !search || text.toLocaleLowerCase(language).includes(search)
  })

  return (
    <div className="rw-grpc-timeline">
      <div className="rw-grpc-timeline-toolbar">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('grpc.searchMessages')} placeholder={t('grpc.searchMessages')} />
        <Select aria-label={t('grpc.messageDirection')} value={direction} onChange={(event) => setDirection(event.target.value as Direction)}>
          <option value="all">{t('grpc.allMessages')}</option>
          <option value="received">{t('grpc.receivedMessages')}</option>
          <option value="sent">{t('grpc.sentMessages')}</option>
        </Select>
      </div>
      {stream.dropped > 0 && <p className="rw-grpc-timeline-notice" role="note">{t('grpc.eventsDropped', { count: stream.dropped })}</p>}
      {rows.length === 0 && <p className="rw-grpc-timeline-notice" role="status">{t(stream.events.length === 0 && pending ? 'grpc.connecting' : 'grpc.noMessages')}</p>}
      <VirtualizedList
        items={rows}
        getKey={(item) => String(item.key)}
        estimatedRowHeight={36}
        className="rw-grpc-timeline-viewport"
        ariaLabel={t('grpc.timeline')}
        renderItem={({ event, key }) => {
          const open = expanded === key
          const label = t(`grpc.event.${event.type}`) + ('index' in event ? ' #' + (event.index + 1) : '')
          const elapsed = 'elapsedMs' in event ? event.elapsedMs : 0
          const timestamp = stream.startedAt ? time.format(stream.startedAt + elapsed) : '+' + elapsed + ' ms'
          const preview = 'json' in event ? event.json.replace(/\s+/g, ' ').slice(0, 200)
            : event.type === 'finished' ? label + ' · ' + event.status.codeName + (event.status.message ? ': ' + event.status.message : '') : label
          const detailId = id + '-' + key
          return (
            <div className={'rw-grpc-event rw-grpc-event--' + event.type + (event.type === 'finished' && event.status.code !== 0 ? ' rw-grpc-event--error' : '')}>
              <button type="button" className="rw-grpc-timeline-row" aria-label={label + ' · ' + timestamp} aria-expanded={open} aria-controls={detailId} onClick={() => setExpanded(open ? null : key)}>
                <span className="rw-grpc-event-direction" aria-hidden="true">{event.type === 'sent' ? '↑' : event.type === 'received' ? '↓' : event.type === 'finished' ? <CheckIcon size={12} /> : '○'}</span>
                <span className={'rw-grpc-event-preview' + ('json' in event ? ' rw-grpc-event-preview--json' : '')}>{preview}</span>
                <span className="rw-grpc-event-size">{'sizeBytes' in event ? formatSize(event.sizeBytes) : ''}</span>
                <time className="rw-grpc-event-time" dateTime={stream.startedAt ? new Date(stream.startedAt + elapsed).toISOString() : undefined}>{timestamp}</time>
                <span className={'rw-grpc-event-chevron' + (open ? ' rw-grpc-event-chevron--open' : '')}><ChevronDownIcon size={12} /></span>
              </button>
              {open && (
                <div className="rw-grpc-event-detail" id={detailId} role="region" aria-label={label}>
                  {'truncated' in event && event.truncated && <p role="note">{t('grpc.messageTruncated')}</p>}
                  {'json' in event ? <ResponseCodeView text={event.json} language="json" partial={event.truncated} /> : event.type === 'started' ? (
                    <p>{t(`grpc.kind.${event.kind}`)}</p>
                  ) : event.type === 'headers' ? (
                    <ResponseHeadersList headers={event.metadata} />
                  ) : (
                    <><p>{event.status.codeName}{event.status.message ? ': ' + event.status.message : ''}</p><ResponseHeadersList headers={event.trailers} /></>
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
