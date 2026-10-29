import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { EditorView } from '@codemirror/view'
import { useLanguage } from '../../../shared/i18n/use-language'
import { IconButton } from '../../../shared/ui/IconButton'
import { Tooltip } from '../../../shared/ui/Tooltip'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import { ChevronDownIcon, CloseIcon, SearchIcon } from '../../../shared/ui/icons'
import { findEditorSearchMatches, updateEditorSearchHighlights } from '../editor-search'
import type { RequestedSearch } from './use-editor-agent-bridge'
import './editor-search.css'

interface SearchOptionButtonProps {
  label: string
  pressed: boolean
  children: string
  onClick: () => void
}

function SearchOptionButton({ label, pressed, children, onClick }: SearchOptionButtonProps) {
  const { triggerProps, tooltip } = useTooltip(label)

  return (
    <>
      <button
        type="button"
        className="rw-editor-search-option"
        aria-label={label}
        aria-pressed={pressed}
        {...triggerProps}
        onClick={onClick}
      >
        {children}
      </button>
      {tooltip}
    </>
  )
}

interface EditorSearchProps {
  text: string
  viewRef: RefObject<EditorView | null>
  isOpen: boolean
  onOpen: () => void
  onClose: () => void
  placement?: 'request' | 'response'
  /** Search started from outside (the agent): fills the query and scrolls to the first match without taking focus. */
  requestedSearch?: RequestedSearch | null
}

export function EditorSearch({ text, viewRef, isOpen, onOpen, onClose, placement = 'request', requestedSearch = null }: EditorSearchProps) {
  const { t } = useLanguage()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regularExpression, setRegularExpression] = useState(false)
  const [requestedIndex, setRequestedIndex] = useState(0)
  const [appliedNonce, setAppliedNonce] = useState<number | null>(null)
  // Last outside request already scrolled to; differs from appliedNonce while one is pending.
  const revealedNonceRef = useRef<number | null>(null)
  // An outside request replaces the query during render, like a reset from props.
  if (requestedSearch && requestedSearch.nonce !== appliedNonce) {
    setAppliedNonce(requestedSearch.nonce)
    setQuery(requestedSearch.text)
    setMatchCase(false)
    setWholeWord(false)
    setRegularExpression(false)
    setRequestedIndex(0)
  }

  const result = useMemo(
    () => findEditorSearchMatches(text, query, { matchCase, wholeWord, regularExpression }),
    [matchCase, query, regularExpression, text, wholeWord],
  )
  const activeIndex = result.matches.length === 0 ? -1 : ((requestedIndex % result.matches.length) + result.matches.length) % result.matches.length

  useEffect(() => {
    if (!isOpen || appliedNonce !== revealedNonceRef.current) return
    inputRef.current?.focus()
    inputRef.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus only when the bar opens; an outside request opens it without focus.
  }, [isOpen])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!isOpen) {
      updateEditorSearchHighlights(view, [], -1)
      return
    }

    updateEditorSearchHighlights(view, result.matches, activeIndex)
    if (appliedNonce !== revealedNonceRef.current) {
      revealedNonceRef.current = appliedNonce
      const first = result.matches[0]
      if (first) view.dispatch({ effects: EditorView.scrollIntoView(first.from, { y: 'center' }) })
    }
  }, [activeIndex, appliedNonce, isOpen, result.matches, viewRef])

  useEffect(
    () => () => {
      const view = viewRef.current
      if (view) updateEditorSearchHighlights(view, [], -1)
    },
    [viewRef],
  )

  const resetSearch = (update: () => void) => {
    setRequestedIndex(0)
    update()
  }

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const navigate = useCallback((direction: -1 | 1) => {
    const view = viewRef.current
    if (!view || result.matches.length === 0) return
    const nextIndex = (activeIndex + direction + result.matches.length) % result.matches.length
    const match = result.matches[nextIndex]
    setRequestedIndex(nextIndex)
    updateEditorSearchHighlights(view, result.matches, nextIndex)
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
    })
  }, [activeIndex, result.matches, viewRef])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const target = event.target
      if (!(target instanceof Node)) return
      const view = viewRef.current
      const searchHasFocus = inputRef.current?.contains(target) ?? false
      const editorHasFocus = view?.dom.contains(target) ?? false
      if (!searchHasFocus && !editorHasFocus) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        focusInput()
        return
      }

      // Enter só navega a partir do campo de busca; no editor ele mantém o
      // comportamento padrão (quebrar linha).
      if (searchHasFocus && event.key === 'Enter' && !(event.ctrlKey || event.metaKey || event.altKey)) {
        event.preventDefault()
        event.stopPropagation()
        navigate(1)
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [focusInput, isOpen, navigate, viewRef])

  const close = () => {
    onClose()
    viewRef.current?.focus()
  }

  const resultLabel = result.invalidRegularExpression
    ? t('editorSearch.invalidRegex')
    : result.matches.length === 0
      ? t('editorSearch.noResults')
      : t('editorSearch.resultCount', {
          current: activeIndex + 1,
          total: `${result.matches.length}${result.limited ? '+' : ''}`,
        })

  return (
    <div className={`rw-editor-search rw-editor-search--${placement}`}>
      {!isOpen ? (
        <IconButton
          className="rw-editor-search-trigger"
          icon={<SearchIcon size={15} />}
          label={t('editorSearch.open')}
          tooltipSide="bottom"
          onClick={onOpen}
        />
      ) : (
        <div className="rw-editor-search-bar" role="search" aria-label={t('editorSearch.label')}>
          <SearchIcon size={14} className="rw-editor-search-input-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            className="rw-editor-search-input"
            aria-label={t('editorSearch.inputLabel')}
            placeholder={t('editorSearch.placeholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => resetSearch(() => setQuery(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
                event.preventDefault()
                event.currentTarget.select()
              }
            }}
          />
          <span className={`rw-editor-search-count${result.invalidRegularExpression ? ' rw-editor-search-count--invalid' : ''}`} aria-live="polite">
            {resultLabel}
          </span>
          <SearchOptionButton
            label={t('editorSearch.matchCase')}
            pressed={matchCase}
            onClick={() => resetSearch(() => setMatchCase((current) => !current))}
          >
            Aa
          </SearchOptionButton>
          <SearchOptionButton
            label={t('editorSearch.wholeWord')}
            pressed={wholeWord}
            onClick={() => resetSearch(() => setWholeWord((current) => !current))}
          >
            ab
          </SearchOptionButton>
          <SearchOptionButton
            label={t('editorSearch.regex')}
            pressed={regularExpression}
            onClick={() => resetSearch(() => setRegularExpression((current) => !current))}
          >
            .*
          </SearchOptionButton>
          <Tooltip label={t('editorSearch.previous')} side="bottom">
            <IconButton
              className="rw-editor-search-previous"
              icon={<ChevronDownIcon size={13} />}
              label={t('editorSearch.previous')}
              tooltip={false}
              disabled={result.matches.length === 0}
              onClick={() => navigate(-1)}
            />
          </Tooltip>
          <Tooltip label={t('editorSearch.next')} side="bottom">
            <IconButton
              icon={<ChevronDownIcon size={13} />}
              label={t('editorSearch.next')}
              tooltip={false}
              disabled={result.matches.length === 0}
              onClick={() => navigate(1)}
            />
          </Tooltip>
          <IconButton
            icon={<CloseIcon size={13} />}
            label={t('editorSearch.close')}
            tooltipSide="bottom"
            onClick={close}
          />
        </div>
      )}
    </div>
  )
}
