import { useEffect, useRef, useState } from 'react'
import type { TranslationKey } from '../../shared/i18n/translations'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon, Spinner } from '../../shared/ui/icons'
import { MarkdownView } from '../notifications/MarkdownView'
import type { AgentChatItem } from './use-agent-session'

/** Items rendered at once; older ones appear on demand. */
const PAGE_SIZE = 150
const KNOWN_TOOLS = new Set([
  'list_open_tabs',
  'get_request',
  'get_response',
  'search_collections',
  'list_environments',
  'open_request',
  'select_tab',
  'new_request_tab',
  'update_request',
  'send_request',
  'save_request',
  'create_collection',
  'create_folder',
  'set_environment_variable',
  'set_active_environment',
])

interface AgentMessageListProps {
  items: AgentChatItem[]
  onApprove: (callId: string) => void
  onDecline: (callId: string) => void
  onRevert: (callId: string) => void
}

export function AgentMessageList({ items, onApprove, onDecline, onRevert }: AgentMessageListProps) {
  const { t } = useLanguage()
  const [visible, setVisible] = useState(PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  // Follow new content while the user is at the bottom; leave them alone after scrolling up.
  useEffect(() => {
    const element = scrollRef.current
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight
  }, [items])

  const hidden = Math.max(0, items.length - visible)
  const shown = hidden > 0 ? items.slice(hidden) : items

  return (
    <div
      ref={scrollRef}
      className="agent-messages"
      role="log"
      aria-live="polite"
      aria-label={t('agent.messagesAria')}
      onScroll={(event) => {
        const element = event.currentTarget
        pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32
      }}
    >
      {hidden > 0 && (
        <Button variant="ghost" className="agent-messages-more" onClick={() => setVisible((count) => count + PAGE_SIZE)}>
          {t('agent.messages.showEarlier', { count: hidden })}
        </Button>
      )}
      {shown.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.id} className="agent-message agent-message--user">
                {item.context.length > 0 && (
                  <p className="agent-message-context">{item.context.map((reference) => `@${reference.label}`).join(' ')}</p>
                )}
                <p className="agent-message-text">{item.text}</p>
              </div>
            )
          case 'assistant':
            return (
              <div key={item.id} className="agent-message agent-message--assistant" aria-busy={item.streaming}>
                <MarkdownView source={item.text} headingOffset={2} renderCodeBlock={(text) => <AgentCodeBlock text={text} />} />
                {item.streaming && <span className="agent-streaming" role="status" aria-label={t('agent.streaming')}><span /><span /><span /></span>}
              </div>
            )
          case 'notice':
            return (
              <p key={item.id} className="agent-notice" data-tone={item.tone} role={item.tone === 'error' ? 'alert' : 'status'}>
                {item.tone === 'error' && <AlertIcon size={13} />}
                <span>{item.text}</span>
              </p>
            )
          case 'tool':
            return <ToolCallCard key={item.id} item={item} onApprove={onApprove} onDecline={onDecline} onRevert={onRevert} />
        }
      })}
    </div>
  )
}

function AgentCodeBlock({ text }: { text: string }) {
  const { t } = useLanguage()
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }
  return (
    <div className="agent-code-block">
      <div className="agent-code-toolbar">
        <span role="status">{status === 'copied' ? t('agent.code.copied') : status === 'error' ? t('agent.code.copyError') : ''}</span>
        <IconButton icon={<CopyIcon size={12} />} label={t('agent.code.copy')} onClick={() => void copy()} />
      </div>
      <pre><code>{text}</code></pre>
    </div>
  )
}

interface ToolCallCardProps {
  item: Extract<AgentChatItem, { kind: 'tool' }>
  onApprove: (callId: string) => void
  onDecline: (callId: string) => void
  onRevert: (callId: string) => void
}

function ToolCallCard({ item, onApprove, onDecline, onRevert }: ToolCallCardProps) {
  const { t } = useLanguage()
  const label = KNOWN_TOOLS.has(item.name) ? t(`agent.tool.${item.name}` as TranslationKey) : item.name
  const icon =
    item.state === 'running' ? (
      <Spinner size={12} />
    ) : item.state === 'done' ? (
      <CheckIcon size={12} />
    ) : item.state === 'awaitingApproval' ? (
      <AlertIcon size={12} />
    ) : (
      <CloseIcon size={12} />
    )
  return (
    <div className="agent-tool" data-state={item.state} data-class={item.toolClass}>
      {item.state === 'awaitingApproval' && <p className="agent-tool-question">{t('agent.approval.question')}</p>}
      <div className="agent-tool-header">
        <span className="agent-tool-icon">{icon}</span>
        <span className="agent-tool-label">{label}</span>
        {item.summary && <span className="agent-tool-summary" title={item.summary}>{item.summary}</span>}
        {item.state !== 'done' && item.state !== 'running' && item.state !== 'awaitingApproval' && (
          <span className="agent-tool-state">{t(`agent.toolState.${item.state}`)}</span>
        )}
      </div>
      {item.state === 'awaitingApproval' && (
        <div className="agent-tool-actions">
          <Button variant="ghost" onClick={() => onDecline(item.id)}>{t('agent.approval.decline')}</Button>
          <Button onClick={() => onApprove(item.id)} autoFocus>{t('agent.approval.approve')}</Button>
        </div>
      )}
      {item.canRevert && (
        <div className="agent-tool-revert">
          <Button variant="ghost" onClick={() => onRevert(item.id)}>{t('agent.revert')}</Button>
        </div>
      )}
    </div>
  )
}
