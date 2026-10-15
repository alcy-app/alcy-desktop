import { useEffect, useRef, useState } from 'react'
import type { GrpcCallEventDto } from '../../../bindings/execute-grpc-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import type { GrpcStreamState } from '../grpc-stream'
import { formatSize } from '../response-summary'
import { ResponseHeadersList } from './ResponseHeadersList'
import './grpc.css'

const ROW_HEIGHT = 32
const VISIBLE_ROWS = 10

/** Fixed-height virtual rows keep long streams responsive; details open separately. */
export function GrpcTimeline({ stream }: { stream: GrpcStreamState }) {
  const { t } = useLanguage()
  const viewport = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, follow: true })
  const [selected, setSelected] = useState<GrpcCallEventDto | null>(null)
  const start = scroll.follow ? Math.max(0, stream.events.length - VISIBLE_ROWS) : Math.min(Math.floor(scroll.top / ROW_HEIGHT), Math.max(0, stream.events.length - 1))
  const rows = stream.events.slice(start, start + VISIBLE_ROWS)
  useEffect(() => {
    if (scroll.follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [stream.events, scroll.follow])

  return (
    <div className="rw-grpc-timeline">
      <div className="rw-grpc-timeline-heading">{t('grpc.timeline')}</div>
      {stream.dropped > 0 && <p role="note">{t('grpc.eventsDropped', { count: stream.dropped })}</p>}
      {stream.events.length === 0 && <p role="status">{t('grpc.connecting')}</p>}
      <div
        ref={viewport}
        className="rw-grpc-timeline-viewport"
        role="list"
        tabIndex={0}
        aria-label={t('grpc.timeline')}
        onScroll={(event) => {
          const node = event.currentTarget
          setScroll({ top: node.scrollTop, follow: node.scrollHeight - node.scrollTop - node.clientHeight < ROW_HEIGHT })
        }}
      >
        <div style={{ height: stream.events.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.map((event, index) => (
            <div role="listitem" key={stream.dropped + start + index} style={{ position: 'absolute', top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT, width: '100%' }}>
              <button type="button" className="rw-grpc-timeline-row" onClick={() => setSelected(event)}>
                <span>{event.type === 'sent' ? '↑ ' : event.type === 'received' ? '↓ ' : ''}{t(`grpc.event.${event.type}`)}{'index' in event ? ` #${event.index + 1}` : ''}</span>
                <span>{'sizeBytes' in event ? `${formatSize(event.sizeBytes)} · ` : ''}{'elapsedMs' in event ? `${event.elapsedMs} ms` : ''}{event.type === 'finished' ? ` · ${event.status.codeName}` : ''}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
      {selected && (
        <div className="rw-grpc-event-detail">
          {'truncated' in selected && selected.truncated && <p role="note">{t('grpc.messageTruncated')}</p>}
          {'json' in selected ? <pre>{selected.json}</pre> : selected.type === 'started' ? (
            <p>{t(`grpc.kind.${selected.kind}`)}</p>
          ) : selected.type === 'headers' ? (
            <ResponseHeadersList headers={selected.metadata} />
          ) : (
            <>
              <p>{selected.status.codeName}{selected.status.message ? `: ${selected.status.message}` : ''}</p>
              <p>{t('grpc.trailers')}</p>
              <ResponseHeadersList headers={selected.trailers} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
