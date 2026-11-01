import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode, type RefObject, type SetStateAction } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { IconButton } from '../../shared/ui/IconButton'
import { AtIcon, ChevronLeftIcon, ChevronRightIcon, StopIcon } from '../../shared/ui/icons'
import { useEditorSelection, type EditorSelection } from '../request-workbench/editor-bridge'
import type { WorkbenchAgentHost } from './agent-host'
import { pasteJsonAsBlock } from './agent-code'
import { AgentContextAttachments } from './AgentContextAttachments'
import { AgentMentionChip } from './AgentMentionChip'
import { CONTEXT_ICONS } from './agent-context-icons'
import { AGENT_COMMANDS, agentCommandQuery, parseAgentCommand, type AgentCommand } from './agent-commands'
import { agentContextOptions, mentionAt, selectionContext, type AgentContextOption } from './agent-context'
import { applyEdit, liveMentions, mentionDeletion, mentionInside, mentionToken, splitMentions, textEdit, type InlineMention, type TextEdit } from './agent-mentions'

interface AgentComposerProps {
  host: WorkbenchAgentHost
  running: boolean
  disabled: boolean
  text: string
  onTextChange: (text: string) => void
  /** Attached items; owned by the panel so chat quotes can be added from the messages. */
  context: AgentContextOption[]
  onContextChange: Dispatch<SetStateAction<AgentContextOption[]>>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** Provider/model picker shown under the text. */
  footer: ReactNode
  onSend: (text: string, context: AgentContextOption[]) => void
  onStop: () => void
  onCommand: (command: AgentCommand) => void
  canCompact: boolean
}

const CATEGORY_KINDS = ['tab', 'request', 'environment', 'flow', 'monitor', 'runner', 'mock'] as const
type CategoryKind = (typeof CATEGORY_KINDS)[number]
type ContextMenuEntry = { type: 'context'; option: AgentContextOption } | { type: 'category'; kind: CategoryKind; disabled: boolean }

function sameSelection(a: EditorSelection | null, b: EditorSelection | null) {
  return a !== null && b !== null && a.slot === b.slot && a.text === b.text
}
const CATEGORY_ICONS = CONTEXT_ICONS

/** Message box: Enter sends, Shift+Enter breaks the line, `@` mentions workbench items inline, pasted JSON becomes a block. */
export function AgentComposer({ host, running, disabled, text, onTextChange: setText, context, onContextChange: setContext, textareaRef, footer, onSend, onStop, onCommand, canCompact }: AgentComposerProps) {
  const { t } = useLanguage()
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [commandQuery, setCommandQuery] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [category, setCategory] = useState<CategoryKind | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  // `@` references live in the text as tokens; this keeps where each one is.
  const [mentionRanges, setMentionRanges] = useState<InlineMention[]>([])
  const mentions = useMemo(() => liveMentions(mentionRanges, text), [mentionRanges, text])
  const lastCaretRef = useRef<{ value: string; caret: number } | null>(null)
  const menuId = useId()
  const mentionOpen = mention !== null || commandQuery !== null
  // The editor selection rides along automatically until dismissed or sent.
  const selection = useEditorSelection()
  const [dismissedSelection, setDismissedSelection] = useState<EditorSelection | null>(null)
  const activeSelection = selection && !sameSelection(selection, dismissedSelection) ? selection : null
  const selectionLabel = activeSelection
    ? t('agent.context.selectionLabel', { where: t(`agent.context.selection.${activeSelection.slot}`) })
    : ''

  useEffect(() => {
    if (!mentionOpen) return
    const close = () => {
      setMention(null)
      setCommandQuery(null)
      setCategory(null)
    }
    // A pointer press can blur the textarea before the menu receives its click.
    const closeOutside = (event: Event) => {
      const target = event.target as Node | null
      if (target === textareaRef.current || menuRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
      window.removeEventListener('blur', close)
    }
  }, [mentionOpen, textareaRef])

  useLayoutEffect(() => {
    const input = textareaRef.current
    if (!input) return
    const resize = () => {
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight}px`
    }
    resize()
    let width = input.clientWidth
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return
      width = input.clientWidth
      resize()
    })
    observer.observe(input)
    return () => observer.disconnect()
  }, [text, textareaRef])

  useEffect(() => {
    menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [category, highlight, mention?.query, commandQuery])

  const options = useMemo(
    () =>
      mention
        ? agentContextOptions(host, mention.query).filter(
            (option) => ![...context, ...mentions.map((item) => item.option)].some((item) => item.kind === option.kind && item.id === option.id),
          )
        : [],
    [context, host, mention, mentions],
  )

  const searching = Boolean(mention?.query)
  const quickOptions = options.filter((option) => option.kind === 'response' || (option.kind === 'tab' && option.id === host.activeTabId()))
  const asEntry = (option: AgentContextOption): ContextMenuEntry => ({ type: 'context', option })
  const entries: ContextMenuEntry[] = category
    ? options.filter((option) => option.kind === category).map(asEntry)
    : searching
      ? options.map(asEntry)
      : [
          ...quickOptions.map(asEntry),
          ...CATEGORY_KINDS.map((kind): ContextMenuEntry => ({ type: 'category', kind, disabled: !options.some((option) => option.kind === kind) })),
        ]
  const selectable = entries.filter((entry) => entry.type === 'context' || !entry.disabled)
  const selected = selectable[Math.min(highlight, selectable.length - 1)]

  const commands = AGENT_COMMANDS.filter((command) => command.startsWith(commandQuery ?? ''))
  const availableCommands = commands.filter((command) => !running && !disabled && (command !== 'compact' || canCompact))
  const selectedCommand = availableCommands[Math.min(highlight, availableCommands.length - 1)]

  const executeCommand = (command: AgentCommand) => {
    if (running || disabled) return
    if (command === 'compact' && !canCompact) {
      setCommandError(t('agent.command.nothing'))
      return
    }
    setText('')
    setCommandQuery(null)
    setCommandError(null)
    setMention(null)
    setMentionRanges([])
    if (command === 'clear') {
      setContext([])
      setDismissedSelection(activeSelection)
    }
    onCommand(command)
    textareaRef.current?.focus()
  }

  /** New text from the user; mentions the edit touched turn back into plain text. */
  const changeText = (value: string, edit: TextEdit) => {
    const next = applyEdit(mentions, edit)
    setMentionRanges(next)
    setText(value)
    return next
  }

  const moveCaret = (caret: number) => {
    const input = textareaRef.current
    if (!input) return
    input.setSelectionRange(caret, caret)
    lastCaretRef.current = { value: input.value, caret }
  }

  const updateMention = (value: string, caret: number, current: InlineMention[] = mentions) => {
    lastCaretRef.current = { value, caret }
    const query = agentCommandQuery(value, caret)
    setCommandQuery(query)
    setCommandError(null)
    const found = query === null ? mentionAt(value, caret) : null
    // Right after a one-word mention the caret would read it as a new `@query`.
    const next = found && current.some((item) => item.start === found.start) ? null : found
    if (next?.start !== mention?.start || next?.query !== mention?.query) setCategory(null)
    setMention(next)
    setHighlight(0)
  }

  const pick = (option: AgentContextOption) => {
    if (!mention) return
    const caret = textareaRef.current?.selectionStart ?? text.length
    const token = mentionToken(option)
    const after = text.slice(caret)
    const spacer = /^\s/.test(after) ? '' : ' '
    const next = text.slice(0, mention.start) + token + spacer + after
    const end = mention.start + token.length
    const shifted = changeText(next, { start: mention.start, oldEnd: caret, insertedLength: token.length + spacer.length })
    setMentionRanges([...shifted, { option, start: mention.start, end }])
    setMention(null)
    setCategory(null)
    const target = end + 1
    lastCaretRef.current = { value: next, caret: target }
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(target, target)
    })
  }

  const submit = () => {
    if (running || disabled || text.trim() === '') return
    if (text.trimStart().startsWith('/')) {
      const command = parseAgentCommand(text)
      if (command) executeCommand(command)
      else setCommandError(t('agent.command.unknown'))
      return
    }
    const attached = [...(activeSelection ? [selectionContext(activeSelection, host, selectionLabel)] : []), ...context, ...mentions.map((item) => item.option)]
      .filter((item, index, all) => all.findIndex((other) => other.kind === item.kind && other.id === item.id) === index)
    onSend(text, attached.map(({ kind, id, label, summary }) => ({ kind, id, label, summary })))
    if (activeSelection) setDismissedSelection(activeSelection)
    setText('')
    setContext([])
    setMentionRanges([])
    setMention(null)
    setCategory(null)
  }

  const activate = (entry: ContextMenuEntry) => {
    if (entry.type === 'context') pick(entry.option)
    else if (!entry.disabled) {
      textareaRef.current?.focus()
      setCategory(entry.kind)
      setHighlight(0)
    }
  }

  const back = () => {
    const index = CATEGORY_KINDS.indexOf(category ?? 'tab')
    const availableBefore = CATEGORY_KINDS.slice(0, index).filter((kind) => options.some((option) => option.kind === kind)).length
    textareaRef.current?.focus()
    setCategory(null)
    setHighlight(quickOptions.length + availableBefore)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return
    if (commandQuery !== null) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCommandQuery(null)
        return
      }
      if (availableCommands.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        setHighlight((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + availableCommands.length) % availableCommands.length)
        return
      }
      if (selectedCommand && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
        event.preventDefault()
        if (event.key === 'Tab') {
          setText(`/${selectedCommand}`)
          setCommandQuery(null)
          requestAnimationFrame(() => textareaRef.current?.focus())
        } else executeCommand(selectedCommand)
        return
      }
    }
    if (mention && category && event.key === 'ArrowLeft') {
      event.preventDefault()
      back()
      return
    }
    if (mention && selected?.type === 'category' && event.key === 'ArrowRight') {
      event.preventDefault()
      activate(selected)
      return
    }
    if (mention && selectable.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((index) => (index + 1) % selectable.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((index) => (index - 1 + selectable.length) % selectable.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        activate(selected)
        return
      }
    }
    if (mention && event.key === 'Escape') {
      event.preventDefault()
      setMention(null)
      return
    }
    if (mentions.length > 0 && !event.altKey && !event.ctrlKey && !event.metaKey && event.currentTarget instanceof HTMLTextAreaElement) {
      const { selectionStart: from, selectionEnd: to } = event.currentTarget
      // A mention is one piece: deleting or crossing it takes it whole.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const removed = mentionDeletion(mentions, from, to, event.key)
        if (removed) {
          event.preventDefault()
          const next = text.slice(0, removed.start) + text.slice(removed.end)
          const remaining = changeText(next, { start: removed.start, oldEnd: removed.end, insertedLength: 0 })
          updateMention(next, removed.start, remaining)
          requestAnimationFrame(() => moveCaret(removed.start))
          return
        }
      }
      if (!event.shiftKey && from === to && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const left = event.key === 'ArrowLeft'
        const crossed = mentions.find((item) => (left ? from > item.start && from <= item.end : from >= item.start && from < item.end))
        if (crossed) {
          event.preventDefault()
          moveCaret(left ? crossed.start : crossed.end)
          return
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="agent-composer" data-disabled={disabled}>
      {commandQuery !== null && (
        <div ref={menuRef} className="agent-context-menu agent-command-menu" onPointerDown={(event) => event.preventDefault()}>
          <div className="agent-context-menu-title"><span className="agent-command-symbol" aria-hidden="true">/</span>{t('agent.command.title')}</div>
          <div className="agent-context-menu-body" role="listbox" id={menuId} aria-label={t('agent.command.title')}>
            {commands.length === 0 && <p className="agent-context-menu-empty">{t('agent.command.unknown')}</p>}
            {commands.map((command, index) => (
              <button
                key={command}
                id={`${menuId}-command-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                className="agent-context-option agent-command-option"
                aria-selected={command === selectedCommand}
                disabled={!availableCommands.includes(command)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => { const index = availableCommands.indexOf(command); if (index >= 0) setHighlight(index) }}
                onClick={() => executeCommand(command)}
              >
                <span className="agent-command-name">/{command}</span>
                <span className="agent-command-description">{t(command === 'compact' && !canCompact ? 'agent.command.nothing' : `agent.command.${command}`)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {mention && (
        <div
          ref={menuRef}
          className="agent-context-menu"
          onPointerDown={(event) => {
            if (event.target instanceof Element && event.target.closest('button')) event.preventDefault()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || (event.target instanceof Element && event.target.closest('[role="option"]'))) onKeyDown(event)
          }}
        >
          <div className="agent-context-menu-title">
            {category ? (
              <IconButton icon={<ChevronLeftIcon size={12} />} label={t('agent.context.back')} onMouseDown={(event) => event.preventDefault()} onClick={back} />
            ) : (
              <span className="agent-context-menu-symbol"><AtIcon size={12} /></span>
            )}
            <span>{category ? t(`agent.context.category.${category}`) : t('agent.context.title')}</span>
          </div>
          <div className="agent-context-menu-body" id={menuId} role="listbox" aria-label={category ? t(`agent.context.category.${category}`) : t('agent.context.menuAria')}>
            {selectable.length === 0 && <p className="agent-context-menu-empty">{t('agent.context.empty')}</p>}
            {entries.map((entry, row) => {
              const isCategory = entry.type === 'category'
              const kind = isCategory ? entry.kind : entry.option.kind
              const ContextIcon = isCategory ? CATEGORY_ICONS[entry.kind] : CONTEXT_ICONS[kind]
              const label = isCategory ? t(`agent.context.category.${entry.kind}`) : entry.option.label
              const disabledEntry = isCategory && entry.disabled
              const index = selectable.indexOf(entry)
              const firstCategory = isCategory && row > 0 && entries[row - 1]?.type === 'context'
              return (
                <button
                  key={isCategory ? entry.kind : `${entry.option.kind}:${entry.option.id}`}
                  type="button"
                  role="option"
                  id={`${menuId}-${row}`}
                  tabIndex={-1}
                  disabled={disabledEntry}
                  aria-disabled={disabledEntry || undefined}
                  aria-selected={entry === selected}
                  aria-expanded={isCategory ? false : undefined}
                  className={[
                    'agent-context-option',
                    firstCategory && 'agent-context-option--category-start',
                    !isCategory && !category && !searching && 'agent-context-option--quick',
                  ].filter(Boolean).join(' ')}
                  title={isCategory ? undefined : `${label}\n${contextDetail(entry.option, t) ?? ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => { if (index >= 0) setHighlight(index) }}
                  onClick={() => activate(entry)}
                >
                  <ContextIcon size={12} />
                  <span className="agent-context-option-label">{label}</span>
                  {isCategory ? <ChevronRightIcon size={10} className="agent-context-option-chevron" /> : (category || searching) && (
                    <span className="agent-context-option-detail">{contextDetail(entry.option, t)}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {(context.length > 0 || activeSelection) && <AgentContextAttachments
        items={activeSelection ? [selectionContext(activeSelection, host, selectionLabel), ...context] : context}
        onRemove={(item) => {
          if (item.kind === 'selection') setDismissedSelection(activeSelection)
          else setContext((current) => current.filter((candidate) => candidate !== item))
        }}
        onClear={() => {
          setContext([])
          setDismissedSelection(activeSelection)
        }}
        onEdit={(item, summary) => setContext((current) => current.map((candidate) => candidate === item ? { ...candidate, summary } : candidate))}
        onReturnFocus={() => textareaRef.current?.focus()}
      />}
      <div className="agent-composer-field" data-mentions={mentions.length > 0 || undefined}>
        {mentions.length > 0 && (
          <div ref={mirrorRef} className="agent-composer-mirror" aria-hidden="true">
            {splitMentions(text, mentions).map((segment, index) =>
              segment.type === 'text' ? segment.text : <AgentMentionChip key={index} kind={segment.mention.option.kind} text={segment.text} />,
            )}
            {'​'}
          </div>
        )}
      <textarea
        ref={textareaRef}
        className="agent-composer-input"
        value={text}
        rows={3}
        disabled={disabled}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={disabled ? t('agent.composer.disabledPlaceholder') : t('agent.composer.placeholder')}
        aria-label={t('agent.composer.aria')}
        aria-controls={mentionOpen ? menuId : undefined}
        aria-expanded={mentionOpen}
        aria-describedby={commandError ? `${menuId}-error` : undefined}
        aria-activedescendant={commandQuery !== null && selectedCommand ? `${menuId}-command-${commands.indexOf(selectedCommand)}` : mention && selected ? `${menuId}-${entries.indexOf(selected)}` : undefined}
        onChange={(event) => {
          const { value, selectionStart } = event.target
          updateMention(value, selectionStart, changeText(value, textEdit(text, value, selectionStart)))
        }}
        onScroll={(event) => {
          if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop
        }}
        onSelect={(event) => {
          const { value, selectionStart, selectionEnd } = event.currentTarget
          // Focus changes can emit select without moving the caret.
          if (lastCaretRef.current?.value === value && lastCaretRef.current.caret === selectionStart) return
          // The caret never rests inside a mention: a click there lands on its nearest edge.
          const inside = selectionStart === selectionEnd ? mentionInside(mentions, selectionStart) : undefined
          if (inside) {
            const edge = selectionStart - inside.start < inside.end - selectionStart ? inside.start : inside.end
            moveCaret(edge)
            updateMention(value, edge)
            return
          }
          updateMention(value, selectionStart)
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const input = event.currentTarget
          const pasted = pasteJsonAsBlock(input.value, input.selectionStart, input.selectionEnd, event.clipboardData.getData('text/plain'))
          if (!pasted) return
          event.preventDefault()
          updateMention(pasted.value, pasted.caret, changeText(pasted.value, textEdit(input.value, pasted.value, pasted.caret)))
          requestAnimationFrame(() => input.setSelectionRange(pasted.caret, pasted.caret))
        }}
      />
      </div>
      {commandError && <p className="agent-command-error" id={`${menuId}-error`} role="alert">{commandError}</p>}
      <div className="agent-composer-footer">
        {footer}
        {running ? (
          <IconButton icon={<StopIcon size={16} />} label={t('agent.composer.stop')} size="md" className="agent-composer-send" data-state="running" onClick={onStop} />
        ) : (
          <IconButton
            icon={
              <svg className="agent-composer-send-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
              </svg>
            }
            label={t('agent.composer.send')}
            size="md"
            className="agent-composer-send"
            disabled={disabled || text.trim() === ''}
            onClick={submit}
          />
        )}
      </div>
    </div>
  )
}

/** Keep provider-facing context summaries out of the presentation. */
function contextDetail(option: AgentContextOption, t: ReturnType<typeof useLanguage>['t']) {
  if (option.kind === 'response') return t('agent.context.responseDetail')
  if (option.kind === 'environment') return t('agent.context.environmentDetail')
  return option.summary.split('\n').pop()?.replace(/ \(unsaved\)$/, '')
}
