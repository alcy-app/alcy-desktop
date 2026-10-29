import { useEffect, useRef, useState, type RefObject } from 'react'
import { deleteAgentSession, listAgentSessions, type AgentSessionSummaryDto } from '../../bindings/agent-sessions'
import { useLanguage } from '../../shared/i18n/use-language'
import { IconButton } from '../../shared/ui/IconButton'
import { EmptyState } from '../../shared/ui/EmptyState'
import { ClockIcon, SearchIcon, Spinner, TrashIcon } from '../../shared/ui/icons'
import { agentErrorMessage } from './use-agent-session'

interface AgentHistoryPopoverProps {
  rootPath: string
  activeSessionId: string | null
  onOpen: (sessionId: string) => void
  onDeleted: (sessionId: string) => void
  onClose: () => void
  triggerRef?: RefObject<HTMLButtonElement | null>
}

type Sessions = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; sessions: AgentSessionSummaryDto[] }

/** Searchable list of this workspace's chats. */
export function AgentHistoryPopover({ rootPath, activeSessionId, onOpen, onDeleted, onClose, triggerRef }: AgentHistoryPopoverProps) {
  const { t, language } = useLanguage()
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<Sessions>({ status: 'loading' })
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void listAgentSessions(rootPath).then((result) => {
      if (cancelled) return
      setSessions(result.ok ? { status: 'ready', sessions: result.value } : { status: 'error', message: agentErrorMessage(result.error, t) })
    })
    return () => {
      cancelled = true
    }
  }, [rootPath, t])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !triggerRef?.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [onClose, triggerRef])

  const remove = async (id: string) => {
    const result = await deleteAgentSession(rootPath, id)
    if (!result.ok) {
      setSessions({ status: 'error', message: agentErrorMessage(result.error, t) })
      return
    }
    setSessions((current) => (current.status === 'ready' ? { status: 'ready', sessions: current.sessions.filter((session) => session.id !== id) } : current))
    onDeleted(id)
  }

  const needle = query.trim().toLowerCase()
  const formatter = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' })
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const filtered = sessions.status === 'ready'
    ? sessions.sessions.filter((session) => needle === '' || session.title.toLowerCase().includes(needle)).sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    : []
  const groups = (['today', 'yesterday', 'older'] as const).map((key) => ({
    key,
    items: filtered.filter((session) => {
      const day = session.updatedAtMs >= today.getTime() ? 'today' : session.updatedAtMs >= yesterday.getTime() ? 'yesterday' : 'older'
      return day === key
    }),
  })).filter((group) => group.items.length > 0)

  return (
    <div
      ref={rootRef}
      className="agent-history"
      role="dialog"
      aria-label={t('agent.history.title')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <label className="agent-history-search">
        <SearchIcon size={12} />
        <input
          autoFocus
          value={query}
          placeholder={t('agent.history.search')}
          aria-label={t('agent.history.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {sessions.status === 'loading' && (
        <p className="agent-history-empty">
          <Spinner size={12} />
        </p>
      )}
      {sessions.status === 'error' && <p className="agent-history-empty" role="alert">{sessions.message}</p>}
      {sessions.status === 'ready' && (
        <div className="agent-history-list">
          {groups.map((group) => (
            <section key={group.key} aria-label={t(`agent.history.${group.key}`)}>
              <h3 className="agent-history-group">{t(`agent.history.${group.key}`)}</h3>
              <ul>
                {group.items.map((session) => (
                  <li key={session.id} className="agent-history-item" aria-current={session.id === activeSessionId ? 'true' : undefined}>
                    <button type="button" className="agent-history-open" onClick={() => onOpen(session.id)}>
                      <span className="agent-history-title">{session.title || t('agent.newChat')}</span>
                      <span className="agent-history-date">{formatter.format(new Date(session.updatedAtMs))}</span>
                    </button>
                    <IconButton
                      icon={<TrashIcon size={12} />}
                      label={t('agent.history.delete', { title: session.title })}
                      variant="danger"
                      disabled={session.id === activeSessionId}
                      onClick={() => void remove(session.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {filtered.length === 0 && <EmptyState icon={<ClockIcon size={20} />} title={t(needle ? 'agent.history.noResults' : 'agent.history.empty')} />}
        </div>
      )}
    </div>
  )
}
