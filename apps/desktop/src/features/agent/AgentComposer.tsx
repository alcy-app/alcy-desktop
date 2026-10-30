import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { IconButton } from '../../shared/ui/IconButton'
import { AtIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, FolderIcon, GlobeIcon, PanelBottomIcon, PanelRightIcon, SelectionIcon, SendIcon, StopIcon, VariablesIcon } from '../../shared/ui/icons'
import { useEditorSelection, type EditorSelection } from '../request-workbench/editor-bridge'
import type { WorkbenchAgentHost } from './agent-host'
import { pasteJsonAsBlock } from './agent-code'
import { agentContextOptions, mentionAt, selectionContext, type AgentContextOption } from './agent-context'

interface AgentComposerProps {
  host: WorkbenchAgentHost
  running: boolean
  disabled: boolean
  text: string
  onTextChange: (text: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** Provider/model picker shown under the text. */
  footer: ReactNode
  onSend: (text: string, context: AgentContextOption[]) => void
  onStop: () => void
}

const CATEGORY_KINDS = ['tab', 'request', 'environment', 'flow', 'monitor', 'runner', 'mock'] as const
type CategoryKind = (typeof CATEGORY_KINDS)[number]
type ContextMenuEntry = { type: 'context'; option: AgentContextOption } | { type: 'category'; kind: CategoryKind; disabled: boolean }
const CONTEXT_ICONS = { response: PanelBottomIcon, tab: PanelRightIcon, request: GlobeIcon, environment: VariablesIcon, selection: SelectionIcon, flow: FolderIcon, monitor: SelectionIcon, runner: SendIcon, mock: GlobeIcon }
const SELECTION_PREVIEW_CHARS = 48

function sameSelection(a: EditorSelection | null, b: EditorSelection | null) {
  return a !== null && b !== null && a.slot === b.slot && a.text === b.text
}
const CATEGORY_ICONS = CONTEXT_ICONS

/** Message box: Enter sends, Shift+Enter breaks the line, `@` attaches workbench items, pasted JSON becomes a block. */
export function AgentComposer({ host, running, disabled, text, onTextChange: setText, textareaRef, footer, onSend, onStop }: AgentComposerProps) {
  const { t } = useLanguage()
  const [context, setContext] = useState<AgentContextOption[]>([])
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [category, setCategory] = useState<CategoryKind | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const lastCaretRef = useRef<{ value: string; caret: number } | null>(null)
  const menuId = useId()
  const mentionOpen = mention !== null
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
  }, [category, highlight, mention?.query])

  const options = useMemo(
    () =>
      mention
        ? agentContextOptions(host, mention.query).filter((option) => !context.some((item) => item.kind === option.kind && item.id === option.id))
        : [],
    [context, host, mention],
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

  const updateMention = (value: string, caret: number) => {
    lastCaretRef.current = { value, caret }
    const next = mentionAt(value, caret)
    if (next?.start !== mention?.start || next?.query !== mention?.query) setCategory(null)
    setMention(next)
    setHighlight(0)
  }

  const pick = (option: AgentContextOption) => {
    if (!mention) return
    const caret = textareaRef.current?.selectionStart ?? text.length
    const next = text.slice(0, mention.start) + text.slice(caret)
    setText(next)
    setContext((current) => [...current, option])
    setMention(null)
    setCategory(null)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(mention.start, mention.start)
    })
  }

  const submit = () => {
    if (running || disabled || text.trim() === '') return
    onSend(text, activeSelection ? [selectionContext(activeSelection, host, selectionLabel), ...context] : context)
    if (activeSelection) setDismissedSelection(activeSelection)
    setText('')
    setContext([])
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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="agent-composer" data-disabled={disabled}>
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
      {(context.length > 0 || activeSelection) && (
        <ul className="agent-context-chips" aria-label={t('agent.context.attachedAria')}>
          {activeSelection && (
            <li className="agent-context-chip agent-context-chip--selection" title={activeSelection.text}>
              <span className="agent-context-chip-kind" title={t('agent.context.kind.selection')}><SelectionIcon size={12} /></span>
              <span className="agent-context-chip-label">
                {selectionLabel}
                <span className="agent-context-chip-preview">
                  {' · '}
                  {activeSelection.text.length > SELECTION_PREVIEW_CHARS ? `${activeSelection.text.slice(0, SELECTION_PREVIEW_CHARS)}…` : activeSelection.text}
                </span>
              </span>
              <IconButton
                icon={<CloseIcon size={10} />}
                label={t('agent.context.removeAria', { name: selectionLabel })}
                tooltip={false}
                onClick={() => setDismissedSelection(activeSelection)}
              />
            </li>
          )}
          {context.map((item) => {
            const ContextIcon = CONTEXT_ICONS[item.kind]
            return (
              <li key={`${item.kind}:${item.id}`} className="agent-context-chip">
                <span className="agent-context-chip-kind" title={t(`agent.context.kind.${item.kind}`)}><ContextIcon size={12} /></span>
                <span className="agent-context-chip-label">{item.label}</span>
                <IconButton
                  icon={<CloseIcon size={10} />}
                  label={t('agent.context.removeAria', { name: item.label })}
                  tooltip={false}
                  onClick={() => setContext((current) => current.filter((candidate) => candidate !== item))}
                />
              </li>
            )
          })}
        </ul>
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
        aria-controls={mention ? menuId : undefined}
        aria-expanded={mention !== null}
        aria-activedescendant={mention && selected ? `${menuId}-${entries.indexOf(selected)}` : undefined}
        onChange={(event) => {
          setText(event.target.value)
          updateMention(event.target.value, event.target.selectionStart)
        }}
        onSelect={(event) => {
          const { value, selectionStart } = event.currentTarget
          // Focus changes can emit select without moving the caret.
          if (lastCaretRef.current?.value === value && lastCaretRef.current.caret === selectionStart) return
          updateMention(value, selectionStart)
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const input = event.currentTarget
          const pasted = pasteJsonAsBlock(input.value, input.selectionStart, input.selectionEnd, event.clipboardData.getData('text/plain'))
          if (!pasted) return
          event.preventDefault()
          setText(pasted.value)
          updateMention(pasted.value, pasted.caret)
          requestAnimationFrame(() => input.setSelectionRange(pasted.caret, pasted.caret))
        }}
      />
      <div className="agent-composer-footer">
        {footer}
        {running ? (
          <IconButton icon={<StopIcon size={13} />} label={t('agent.composer.stop')} size="md" className="agent-composer-send" onClick={onStop} />
        ) : (
          <IconButton
            icon={<SendIcon size={13} />}
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
