import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { AlertIcon, AtIcon, CheckIcon, ChevronRightIcon, CloseIcon, CopyIcon, FlowIcon, GlobeIcon, MockServerIcon, PanelRightIcon, PencilIcon, Spinner } from '../../shared/ui/icons'
import { MenuItem } from '../../shared/ui/Menu'
import { MarkdownView } from '../notifications/MarkdownView'
import { highlightSpans } from '../request-workbench/screenshot/screenshot-highlight'
import { codeBlockLanguage, splitUserMessage } from './agent-code'
import { isAgentReferenceKind, type AgentReferenceKind } from './agent-references'
import type { AgentChatItem } from './use-agent-session'
import { toolLabel } from './agent-tool-labels'
import { AgentThinking } from './AgentThinking'
import { splitAgentReply } from './agent-follow-ups'
import { TurnTokens } from './AgentTokens'
import type { AgentContextOption } from './agent-context'

/** Items rendered at once; older ones appear on demand. */
const PAGE_SIZE = 150

interface AgentMessageListProps {
  items: AgentChatItem[]
  running?: boolean
  compacting?: boolean
  onApprove: (callId: string) => void
  onDecline: (callId: string) => void
  onRevert: (callId: string) => void
  /** Opens an item the reply links to; resolves false when it is gone. */
  onOpenReference?: (kind: AgentReferenceKind, id: string) => Promise<boolean>
  /** Item named by a bolded or code-formatted word of a reply, when it is unambiguous. */
  resolveReference?: (text: string) => { kind: AgentReferenceKind; id: string } | null
  /** Sends the last message again after its turn failed. */
  onRetry?: () => void
  /** Sends an edited last message in place of the original. */
  onEditLast?: (text: string) => void
  /** Attaches a message, or a selected part of one, as context of the next message. */
  onQuote?: (text: string, label: string, kind: NonNullable<AgentContextOption['quoteKind']>) => void
  /** Sends a suggested continuation as a new user message. */
  onFollowUp?: (text: string) => void
}

const EXCERPT_LABEL_CHARS = 32

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

export function AgentMessageList({ items, running = false, compacting = false, onApprove, onDecline, onRevert, onOpenReference, resolveReference, onRetry, onEditLast, onQuote, onFollowUp }: AgentMessageListProps) {
  const { t, language } = useLanguage()
  const [visible, setVisible] = useState(PAGE_SIZE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number; text: string; range: Range; floating?: boolean } | null>(null)
  const last = items.at(-1)
  // The token line of a turn does not end it: follow-ups still belong to the reply above it.
  const lastContent = items.findLast((item) => item.kind !== 'usage')
  const lastUserId = items.findLast((item) => item.kind === 'user')?.id
  // Only the last message can be edited, and not while a turn runs.
  const editing = editingId !== null && editingId === lastUserId && !running ? editingId : null
  const thinking = running
    && !compacting
    && !(last?.kind === 'assistant' && last.streaming)
    && !(last?.kind === 'tool' && (last.state === 'running' || last.state === 'awaitingApproval'))

  const trackScroll = useCallback((element: HTMLDivElement) => {
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32
    pinnedToBottom.current = atBottom
    setShowScrollToBottom(!atBottom)
  }, [])

  // Follow new content while the user is at the bottom; leave them alone after scrolling up.
  useEffect(() => {
    const element = scrollRef.current
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight
  }, [items, thinking, compacting])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current) element.scrollTop = element.scrollHeight
      trackScroll(element)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [trackScroll])

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
  const quoteLabel = (labelKey: 'agent.quote.prompt' | 'agent.quote.reply', atMs: number | undefined) =>
    atMs === undefined ? t(labelKey) : t('agent.quote.at', { label: t(labelKey), time: timeFormat.format(atMs) })
  const quote = (text: string, label: string, kind: 'message' | 'reply') => (onQuote ? () => onQuote(text, label, kind) : undefined)

  return (
    <div className="agent-message-area">
      <div
        ref={scrollRef}
        className="agent-messages"
        role="log"
        aria-live="polite"
        aria-label={t('agent.messagesAria')}
        tabIndex={-1}
        onScroll={(event) => trackScroll(event.currentTarget)}
        onMouseUp={(event) => {
          if (event.button !== 0 || !onQuote) return
          const selection = window.getSelection()
          const text = selection?.toString().trim()
          if (!text || !selection?.anchorNode || !selection.focusNode) return
          const message = selection.anchorNode.parentElement?.closest('.agent-message')
          if (!message || !event.currentTarget.contains(message) || !message.contains(selection.focusNode)) return
          const range = selection.getRangeAt(0).cloneRange()
          const bounds = range.getBoundingClientRect()
          setSelectionMenu({ x: bounds.left, y: bounds.bottom + 8, text, range, floating: true })
        }}
        onContextMenu={(event) => {
          // With text selected in the chat, the right button offers it as context; otherwise the usual menu.
          const selection = window.getSelection()
          const text = selection?.toString().trim() ?? ''
          if (!onQuote || !text || !selection?.anchorNode || !event.currentTarget.contains(selection.anchorNode)) return
          event.preventDefault()
          setSelectionMenu({ x: event.clientX, y: event.clientY, text, range: selection.getRangeAt(0).cloneRange() })
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
                    {editing === item.id ? (
                      <UserMessageEditor
                        text={item.text}
                        onCancel={() => setEditingId(null)}
                        onSend={(text) => {
                          setEditingId(null)
                          onEditLast?.(text)
                        }}
                      />
                    ) : (
                      <>
                        <div className="agent-message agent-message--user">
                          {item.context.length > 0 && (
                            <p className="agent-message-context">{item.context.map((reference) => `@${reference.label}`).join(' ')}</p>
                          )}
                          <UserMessageText text={item.text} />
                        </div>
                        <MessageActions
                          text={item.text}
                          onQuote={quote(item.text, quoteLabel('agent.quote.prompt', item.atMs), 'message')}
                          onEdit={onEditLast && !running && item.id === lastUserId ? () => setEditingId(item.id) : undefined}
                        />
                      </>
                    )}
                  </div>
                </Fragment>
              )
            case 'assistant': {
              const reply = splitAgentReply(item.text)
              return (
                <Fragment key={item.id}>
                  {dayLine(item.id, item.atMs)}
                  {timeLabel(item.atMs)}
                  <div className="agent-message-group">
                    <div className="agent-message agent-message--assistant" aria-busy={item.streaming}>
                      <MarkdownView
                        source={reply.text}
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
                    {!item.streaming && reply.text.trim() !== '' && <MessageActions text={reply.text} onQuote={quote(reply.text, quoteLabel('agent.quote.reply', item.atMs), 'reply')} />}
                    {!running && !item.streaming && item.id === lastContent?.id && onFollowUp && reply.suggestions.length > 0 && (
                      <div className="agent-follow-ups" role="group" aria-label={t('agent.followUps.title')}>
                        <p className="agent-follow-ups-title">{t('agent.followUps.title')}</p>
                        <div className="agent-follow-ups-options">
                          {reply.suggestions.map((suggestion) => (
                            <Button key={suggestion} variant="ghost" className="agent-follow-up" onClick={() => onFollowUp(suggestion)}>
                              {suggestion}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Fragment>
              )
            }
            case 'notice':
              return (
                <p key={item.id} className="agent-notice" data-tone={item.tone} role={item.tone === 'error' ? 'alert' : 'status'}>
                  {item.tone === 'error' && <AlertIcon size={13} />}
                  <span>{item.text}</span>
                  {item.retry && item.id === last?.id && !running && onRetry && (
                    <Button variant="ghost" className="agent-notice-action" onClick={onRetry}>{t('agent.notice.retry')}</Button>
                  )}
                </p>
              )
            case 'tool':
              return <ToolCallCard key={item.id} item={item} onApprove={onApprove} onDecline={onDecline} onRevert={onRevert} />
            case 'usage':
              return <TurnTokens key={item.id} tokens={item} />
          }
        })}
        {thinking && <AgentThinking />}
        {compacting && <p className="agent-notice" role="status"><Spinner size={13} /><span>{t('agent.command.compacting')}</span></p>}
        {selectionMenu && onQuote && (
          <SelectionMenu
            {...selectionMenu}
            onClose={() => setSelectionMenu(null)}
            onQuote={() => onQuote(selectionMenu.text, t('agent.quote.excerpt', { text: excerpt(selectionMenu.text) }), 'selection')}
          />
        )}
      </div>
      {showScrollToBottom && (
        <IconButton
          className="agent-scroll-bottom"
          label={t('agent.messages.scrollToBottom')}
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
            </svg>
          }
          onClick={() => {
            const element = scrollRef.current
            if (!element) return
            pinnedToBottom.current = true
            element.scrollTop = element.scrollHeight
            setShowScrollToBottom(false)
            element.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_LABEL_CHARS ? `${flat.slice(0, EXCERPT_LABEL_CHARS)}…` : flat
}

interface SelectionMenuProps {
  floating?: boolean
  x: number
  y: number
  text: string
  /** The selected range, put back after the menu takes the focus. */
  range: Range
  onQuote: () => void
  onClose: () => void
}

/** Right-click menu for text selected in the chat. */
function SelectionMenu({ x, y, text, range, floating = false, onQuote, onClose }: SelectionMenuProps) {
  const { t } = useLanguage()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // Focusing the first item clears the selection in WebKit; keep it on screen while the menu is open and after.
  useEffect(() => {
    const selection = window.getSelection()
    if (!selection) return
    selection.removeAllRanges()
    selection.addRange(range)
  }, [range])

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)) })
  }, [x, y])

  useEffect(() => {
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (!ref.current?.contains(event.target as Node | null)) onClose()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className={`ui-menu agent-selection-menu${floating ? ' agent-selection-menu--floating' : ''}`}
      role="menu"
      aria-label={t('agent.quote.menuAria')}
      style={position}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <MenuItem
        label={t('agent.quote.useSelection')}
        icon={<AtIcon size={12} />}
        autoFocus={!floating}
        onSelect={() => {
          onQuote()
          onClose()
        }}
      />
      <MenuItem
        label={t('agent.quote.copy')}
        icon={<CopyIcon size={12} />}
        onSelect={() => {
          void navigator.clipboard?.writeText(text).catch(() => undefined)
          onClose()
        }}
      />
    </div>
  )
}

interface UserMessageEditorProps {
  text: string
  onSend: (text: string) => void
  onCancel: () => void
}

/** The last message, edited in place: Enter sends it again, Shift+Enter breaks the line, Esc cancels. */
function UserMessageEditor({ text, onSend, onCancel }: UserMessageEditorProps) {
  const { t } = useLanguage()
  const [value, setValue] = useState(text)
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [])

  useLayoutEffect(() => {
    const input = ref.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }, [value])

  const submit = () => {
    if (value.trim() !== '') onSend(value)
  }

  return (
    <div className="agent-message-editor">
      <textarea
        ref={ref}
        className="agent-message-editor-input"
        aria-label={t('agent.message.editAria')}
        value={value}
        rows={1}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="agent-message-editor-actions">
        <Button variant="ghost" onClick={onCancel}>{t('agent.message.editCancel')}</Button>
        <Button disabled={value.trim() === ''} onClick={submit}>{t('agent.message.editSend')}</Button>
      </div>
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
function MessageActions({ text, onQuote, onEdit }: { text: string; onQuote?: () => void; onEdit?: () => void }) {
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
      {onQuote && <IconButton icon={<AtIcon size={13} />} label={t('agent.message.quote')} onPointerUp={releasePointerFocus} onClick={onQuote} />}
      {onEdit && <IconButton icon={<PencilIcon size={13} />} label={t('agent.message.edit')} onPointerUp={releasePointerFocus} onClick={onEdit} />}
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
