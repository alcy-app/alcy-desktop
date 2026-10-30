import { Fragment, useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { TranslationKey } from '../../shared/i18n/translations'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { AlertIcon, CheckIcon, ChevronRightIcon, CloseIcon, CopyIcon, FlowIcon, GlobeIcon, MockServerIcon, PanelRightIcon, Spinner } from '../../shared/ui/icons'
import { MarkdownView } from '../notifications/MarkdownView'
import { highlightSpans } from '../request-workbench/screenshot/screenshot-highlight'
import { codeBlockLanguage, splitUserMessage } from './agent-code'
import { isAgentReferenceKind, type AgentReferenceKind } from './agent-references'
import type { AgentChatItem } from './use-agent-session'
import { RESOURCE_TOOL_NAMES } from './agent-resource-tools'
import { AgentThinking } from './AgentThinking'

/** Items rendered at once; older ones appear on demand. */
const PAGE_SIZE = 150
const KNOWN_TOOLS = new Set([
  ...RESOURCE_TOOL_NAMES,
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
  'cancel_request',
  'send_grpc_message',
  'close_grpc_send',
  'save_request',
  'create_collection',
  'create_folder',
  'set_environment_variable',
  'set_active_environment',
  'close_tab',
  'highlight_in_editor',
])

interface AgentMessageListProps {
  items: AgentChatItem[]
  running?: boolean
  onApprove: (callId: string) => void
  onDecline: (callId: string) => void
  onRevert: (callId: string) => void
  /** Opens an item the reply links to; resolves false when it is gone. */
  onOpenReference?: (kind: AgentReferenceKind, id: string) => Promise<boolean>
  /** Item named by a bolded or code-formatted word of a reply, when it is unambiguous. */
  resolveReference?: (text: string) => { kind: AgentReferenceKind; id: string } | null
}

const REFERENCE_ICONS = { request: GlobeIcon, flow: FlowIcon, mock: MockServerIcon, tab: PanelRightIcon }

type ToolItem = Extract<AgentChatItem, { kind: 'tool' }>
type Row = { kind: 'item'; item: AgentChatItem } | { kind: 'tools'; id: string; tools: ToolItem[] }

/**
 * Runs of two or more consecutive tool calls collapse into one group, as in
 * editor chats. A call waiting for approval always stands alone, so its
 * question and buttons stay in sight.
 */
function groupToolRuns(items: AgentChatItem[]): Row[] {
  const rows: Row[] = []
  let run: ToolItem[] = []
  const flush = () => {
    if (run.length > 1) rows.push({ kind: 'tools', id: run[0].id, tools: run })
    else if (run.length === 1) rows.push({ kind: 'item', item: run[0] })
    run = []
  }
  for (const item of items) {
    if (item.kind === 'tool' && item.state !== 'awaitingApproval') {
      run.push(item)
      continue
    }
    flush()
    rows.push({ kind: 'item', item })
  }
  flush()
  return rows
}

/** Ids of the messages that open a new day, as in editor chats; messages without a time open none. */
function firstMessagesOfEachDay(items: AgentChatItem[]): Set<string> {
  const ids = new Set<string>()
  let lastDay: string | null = null
  for (const item of items) {
    if ((item.kind !== 'user' && item.kind !== 'assistant') || item.atMs === undefined) continue
    const day = new Date(item.atMs).toDateString()
    if (day !== lastDay) ids.add(item.id)
    lastDay = day
  }
  return ids
}

export function AgentMessageList({ items, running = false, onApprove, onDecline, onRevert, onOpenReference, resolveReference }: AgentMessageListProps) {
  const { t, language } = useLanguage()
  const [visible, setVisible] = useState(PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const last = items.at(-1)
  const thinking = running
    && !(last?.kind === 'assistant' && last.streaming)
    && !(last?.kind === 'tool' && (last.state === 'running' || last.state === 'awaitingApproval'))

  // Follow new content while the user is at the bottom; leave them alone after scrolling up.
  useEffect(() => {
    const element = scrollRef.current
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight
  }, [items, thinking])

  const hidden = Math.max(0, items.length - visible)
  const shown = hidden > 0 ? items.slice(hidden) : items
  const timeFormat = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' })
  const dayFormat = new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', month: 'short' })
  const newDays = firstMessagesOfEachDay(shown)
  const dayLine = (id: string, atMs: number | undefined) =>
    atMs !== undefined && newDays.has(id) ? (
      <p className="agent-day" role="separator">
        <span>{dayFormat.format(atMs)}</span>
      </p>
    ) : null
  const timeLabel = (atMs: number | undefined) =>
    atMs === undefined ? null : (
      <time className="agent-message-time" dateTime={new Date(atMs).toISOString()}>
        {timeFormat.format(atMs)}
      </time>
    )

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
      {groupToolRuns(shown).map((row) => {
        if (row.kind === 'tools') {
          return <ToolCallGroup key={row.id} tools={row.tools} onApprove={onApprove} onDecline={onDecline} onRevert={onRevert} />
        }
        const { item } = row
        switch (item.kind) {
          case 'user':
            return (
              <Fragment key={item.id}>
                {dayLine(item.id, item.atMs)}
                {timeLabel(item.atMs)}
                <div className="agent-message-group agent-message-group--user">
                  <div className="agent-message agent-message--user">
                    {item.context.length > 0 && (
                      <p className="agent-message-context">{item.context.map((reference) => `@${reference.label}`).join(' ')}</p>
                    )}
                    <UserMessageText text={item.text} />
                  </div>
                  <MessageActions text={item.text} />
                </div>
              </Fragment>
            )
          case 'assistant':
            return (
              <Fragment key={item.id}>
                {dayLine(item.id, item.atMs)}
                {timeLabel(item.atMs)}
                <div className="agent-message-group">
                  <div className="agent-message agent-message--assistant" aria-busy={item.streaming}>
                    <MarkdownView
                      source={item.text}
                      headingOffset={2}
                      renderCodeBlock={(text, lang) => <AgentCodeBlock text={text} lang={lang} />}
                      resolveReference={resolveReference}
                      renderReference={(kind, id, children, key) =>
                        onOpenReference && isAgentReferenceKind(kind) ? (
                          <AgentReference key={key} kind={kind} id={id} onOpen={onOpenReference}>{children}</AgentReference>
                        ) : (
                          <strong key={key}>{children}</strong>
                        )
                      }
                    />
                    {item.streaming && <span className="agent-streaming" role="status" aria-label={t('agent.streaming')}><span /><span /><span /></span>}
                  </div>
                  {!item.streaming && item.text.trim() !== '' && <MessageActions text={item.text} />}
                </div>
              </Fragment>
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
      {thinking && <AgentThinking />}
    </div>
  )
}

/** A request, flow, mock or tab named in a reply; clicking opens its tab. */
function AgentReference({ kind, id, onOpen, children }: { kind: AgentReferenceKind; id: string; onOpen: (kind: AgentReferenceKind, id: string) => Promise<boolean>; children: ReactNode }) {
  const { t } = useLanguage()
  const [state, setState] = useState<'idle' | 'opening' | 'missing'>('idle')
  const Icon = REFERENCE_ICONS[kind]
  const open = async () => {
    if (state === 'opening') return
    setState('opening')
    setState((await onOpen(kind, id)) ? 'idle' : 'missing')
  }
  return (
    <button
      type="button"
      className="agent-reference"
      data-state={state}
      title={state === 'missing' ? t('agent.reference.missing') : t(`agent.reference.${kind}`)}
      aria-busy={state === 'opening' || undefined}
      onPointerUp={releasePointerFocus}
      onClick={() => void open()}
    >
      <Icon size={11} />
      <span>{children}</span>
    </button>
  )
}

/** The user's words stay literal; only their fenced (or pasted JSON) blocks become code blocks. */
function UserMessageText({ text }: { text: string }) {
  const segments = useMemo(() => splitUserMessage(text), [text])
  return segments.map((segment, index) =>
    segment.type === 'code' ? (
      <AgentCodeBlock key={index} text={segment.text} lang={segment.lang} />
    ) : (
      <p key={index} className="agent-message-text">{segment.text}</p>
    ),
  )
}

/**
 * WebKitGTK treats focus from a click as :focus-visible, so a clicked button
 * would keep its ring (and keep hover-only actions shown) until focus moves.
 * A pointer press lets go of the focus; the keyboard never fires `pointerup`.
 */
function releasePointerFocus(event: PointerEvent<HTMLButtonElement>) {
  event.currentTarget.blur()
}

/** Clipboard copy whose outcome shows for a moment. */
function useCopy(text: string) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = window.setTimeout(() => setStatus('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [status])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }
  return { status, copy }
}

/** Actions under a message, as in other chats: copies its text as written (Markdown for replies). */
function MessageActions({ text }: { text: string }) {
  const { t } = useLanguage()
  const { status, copy } = useCopy(text)
  return (
    <div className="agent-message-actions">
      <IconButton
        icon={<CopyIcon size={13} />}
        label={status === 'copied' ? t('agent.code.copied') : status === 'error' ? t('agent.code.copyError') : t('agent.message.copy')}
        data-status={status}
        onPointerUp={releasePointerFocus}
        onClick={() => void copy()}
      />
    </div>
  )
}

function AgentCodeBlock({ text, lang }: { text: string; lang?: string }) {
  const { t } = useLanguage()
  const language = useMemo(() => codeBlockLanguage(lang, text), [lang, text])
  const spans = useMemo(() => (language.highlight === 'text' ? null : highlightSpans(text, language.highlight)), [language.highlight, text])
  const { status, copy } = useCopy(text)
  return (
    <div className="agent-code-block">
      <div className="agent-code-toolbar">
        {language.label && <span className="agent-code-language">{language.label}</span>}
        <span role="status">{status === 'copied' ? t('agent.code.copied') : status === 'error' ? t('agent.code.copyError') : ''}</span>
        <IconButton
          icon={<CopyIcon size={12} />}
          label={t('agent.code.copy')}
          onPointerUp={releasePointerFocus}
          onClick={() => void copy()}
        />
      </div>
      <pre>
        <code>
          {spans
            ? spans.map((span, index) => span.tone === 'plain' ? span.text : <span key={index} className={`agent-code-token agent-code-token--${span.tone}`}>{span.text}</span>)
            : text}
        </code>
      </pre>
    </div>
  )
}

interface ToolCallGroupProps {
  tools: ToolItem[]
  onApprove: (callId: string) => void
  onDecline: (callId: string) => void
  onRevert: (callId: string) => void
}

/** A collapsed chain of tool calls: what is running now, or how many ran; expanding lists each one. */
function ToolCallGroup({ tools, onApprove, onDecline, onRevert }: ToolCallGroupProps) {
  const { t } = useLanguage()
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const running = tools.find((tool) => tool.state === 'running')
  const failed = tools.filter((tool) => tool.state === 'failed').length
  const icon = running ? <Spinner size={12} /> : failed > 0 ? <AlertIcon size={12} /> : <CheckIcon size={12} />
  return (
    <div className="agent-tool-group" data-state={running ? 'running' : failed > 0 ? 'failed' : 'done'}>
      <button type="button" className="agent-tool-group-toggle" aria-expanded={expanded} aria-controls={bodyId} onPointerUp={releasePointerFocus} onClick={() => setExpanded((open) => !open)}>
        <ChevronRightIcon size={10} className="agent-tool-group-chevron" />
        <span className="agent-tool-icon">{icon}</span>
        <span className="agent-tool-label">
          {t(running ? 'agent.toolGroup.running' : 'agent.toolGroup.done', { count: tools.length })}
          {failed > 0 && ` · ${t('agent.toolGroup.failed', { count: failed })}`}
        </span>
        {running && <span className="agent-tool-summary">{toolLabel(running.name, t)}</span>}
      </button>
      {expanded && (
        <div id={bodyId} className="agent-tool-group-items">
          {tools.map((tool) => <ToolCallCard key={tool.id} item={tool} onApprove={onApprove} onDecline={onDecline} onRevert={onRevert} />)}
        </div>
      )}
    </div>
  )
}

function toolLabel(name: string, t: ReturnType<typeof useLanguage>['t']) {
  return KNOWN_TOOLS.has(name) ? t(`agent.tool.${name}` as TranslationKey) : name
}

interface ToolCallCardProps {
  item: Extract<AgentChatItem, { kind: 'tool' }>
  onApprove: (callId: string) => void
  onDecline: (callId: string) => void
  onRevert: (callId: string) => void
}

function ToolCallCard({ item, onApprove, onDecline, onRevert }: ToolCallCardProps) {
  const { t } = useLanguage()
  const label = toolLabel(item.name, t)
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
        {item.state !== 'done' && item.state !== 'running' && item.state !== 'awaitingApproval' ? (
          <span className="agent-tool-state">{t(`agent.toolState.${item.state}`)}</span>
        ) : (
          item.autoApproved && <span className="agent-tool-state agent-tool-state--auto">{t('agent.toolState.autoApproved')}</span>
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
