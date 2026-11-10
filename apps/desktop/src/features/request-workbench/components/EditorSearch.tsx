import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { EditorView } from '@codemirror/view'
import { useLanguage } from '../../../shared/i18n/use-language'
import { IconButton } from '../../../shared/ui/IconButton'
import { Tooltip } from '../../../shared/ui/Tooltip'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, ReplaceAllIcon, ReplaceIcon, SearchIcon, SelectionIcon } from '../../../shared/ui/icons'
import {
  buildEditorSearchReplacements,
  findEditorSearchMatches,
  mapRangeThroughTextChange,
  searchSeedFromSelection,
  updateEditorSearchHighlights,
} from '../editor-search'
import type { EditorSearchRange, EditorSearchState } from '../editor-search'
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
  /** Query, options and active match to start from (a view coming back to its tab); read only at mount. */
  initialState?: EditorSearchState | null
  /** Reports the search state as it changes, so the view can keep it past an unmount. */
  onStateChange?: (state: EditorSearchState) => void
}

export function EditorSearch({
  text,
  viewRef,
  isOpen,
  onOpen,
  onClose,
  placement = 'request',
  requestedSearch = null,
  initialState = null,
  onStateChange,
}: EditorSearchProps) {
  const { t } = useLanguage()
  // The response is read-only: it can be searched, never replaced.
  const canReplace = placement === 'request'
  const barRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState(initialState?.query ?? '')
  const [matchCase, setMatchCase] = useState(initialState?.matchCase ?? false)
  const [wholeWord, setWholeWord] = useState(initialState?.wholeWord ?? false)
  const [regularExpression, setRegularExpression] = useState(initialState?.regularExpression ?? false)
  const [requestedIndex, setRequestedIndex] = useState(initialState?.activeIndex ?? 0)
  const [isReplaceOpen, setIsReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [preserveCase, setPreserveCase] = useState(false)
  // The text the range refers to travels with it, so an edit can move the range.
  const [searchScope, setSearchScope] = useState<{ range: EditorSearchRange; text: string } | null>(null)
  // Mounting already open (restored state) keeps focus where it is; only opening the bar takes it.
  const wasOpenRef = useRef(isOpen)
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
    setSearchScope(null)
  }

  if (searchScope && searchScope.text !== text) {
    const range = mapRangeThroughTextChange(searchScope.range, searchScope.text, text)
    setSearchScope(range ? { range, text } : null)
  }
  const scope = searchScope?.range ?? null

  const searchOptions = useMemo(
    () => ({ matchCase, wholeWord, regularExpression }),
    [matchCase, regularExpression, wholeWord],
  )
  const result = useMemo(
    () => findEditorSearchMatches(text, query, searchOptions, scope),
    [query, scope, searchOptions, text],
  )
  const activeIndex = result.matches.length === 0 ? -1 : ((requestedIndex % result.matches.length) + result.matches.length) % result.matches.length

  useEffect(() => {
    const opened = isOpen && !wasOpenRef.current
    wasOpenRef.current = isOpen
    if (!opened || appliedNonce !== revealedNonceRef.current) return
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

    updateEditorSearchHighlights(view, result.matches, activeIndex, scope)
    if (appliedNonce !== revealedNonceRef.current) {
      revealedNonceRef.current = appliedNonce
      const first = result.matches[0]
      if (first) view.dispatch({ effects: EditorView.scrollIntoView(first.from, { y: 'center' }) })
    }
  }, [activeIndex, appliedNonce, isOpen, result.matches, scope, viewRef])

  useEffect(() => {
    // The requested index, not the resolved one: with no matches yet (body still formatting) it is kept as it was.
    onStateChange?.({ isOpen, query, matchCase, wholeWord, regularExpression, activeIndex: requestedIndex })
  }, [isOpen, matchCase, onStateChange, query, regularExpression, requestedIndex, wholeWord])

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

  // Ctrl+F/Ctrl+H: focused after the render, so a query just taken from the selection is the one selected
  // and a replace row just opened exists. Runs after the effect that focuses the bar when it opens.
  const [focusRequest, setFocusRequest] = useState<{ target: 'find' | 'replace' } | null>(null)
  useEffect(() => {
    if (!focusRequest) return
    const input = focusRequest.target === 'replace' ? replaceInputRef.current : inputRef.current
    input?.focus()
    input?.select()
  }, [focusRequest])

  const navigate = useCallback((direction: -1 | 1) => {
    const view = viewRef.current
    if (!view || result.matches.length === 0) return
    const nextIndex = (activeIndex + direction + result.matches.length) % result.matches.length
    const match = result.matches[nextIndex]
    setRequestedIndex(nextIndex)
    updateEditorSearchHighlights(view, result.matches, nextIndex, scope)
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
    })
  }, [activeIndex, result.matches, scope, viewRef])

  /** Searches for the editor's selection, with the selected occurrence as the active match. Returns whether it did. */
  const seedFromSelection = useCallback((view: EditorView) => {
    const selection = view.state.selection.main
    const seed = searchSeedFromSelection(view.state.sliceDoc(selection.from, selection.to), searchOptions.regularExpression)
    if (seed === null) return false
    const { matches } = findEditorSearchMatches(text, seed, searchOptions, scope)
    setQuery(seed)
    setRequestedIndex(Math.max(0, matches.findIndex((match) => match.from === selection.from)))
    return true
  }, [scope, searchOptions, text])

  const replaceCurrent = () => {
    const view = viewRef.current
    if (!view || activeIndex < 0) return
    // The document, not the `text` prop: it is what the change will apply to.
    const current = view.state.doc.toString()
    const replaceOptions = { replacement, preserveCase }
    const change = buildEditorSearchReplacements(current, query, searchOptions, replaceOptions, scope)[activeIndex]
    if (!change) return

    const updated = `${current.slice(0, change.from)}${change.insert}${current.slice(change.to)}`
    const updatedScope = scope && mapRangeThroughTextChange(scope, current, updated)
    const { matches } = findEditorSearchMatches(updated, query, searchOptions, updatedScope)
    // The next occurrence after the inserted text, which may itself match; past the last one it wraps to the first.
    const resumeAt = change.from + change.insert.length
    const nextIndex = Math.max(0, matches.findIndex((match) => match.from >= resumeAt))
    const next = matches[nextIndex]
    setRequestedIndex(nextIndex)
    view.dispatch({
      changes: change,
      selection: next ? { anchor: next.from, head: next.to } : { anchor: resumeAt },
      effects: EditorView.scrollIntoView(next?.from ?? resumeAt, { y: 'center' }),
      userEvent: 'input.replace',
    })
  }

  const replaceAll = () => {
    const view = viewRef.current
    if (!view) return
    const changes = buildEditorSearchReplacements(
      view.state.doc.toString(),
      query,
      searchOptions,
      { replacement, preserveCase },
      scope,
    )
    if (changes.length === 0) return
    setRequestedIndex(0)
    // A single transaction, so one undo brings everything back.
    view.dispatch({ changes, userEvent: 'input.replace' })
  }

  /** Restricts the search to the editor's selection; without a selection there is nothing to restrict to. */
  const toggleSearchScope = () => {
    if (searchScope) {
      resetSearch(() => setSearchScope(null))
      return
    }
    const selection = viewRef.current?.state.selection.main
    if (!selection || selection.empty) return
    resetSearch(() => setSearchScope({ range: { from: selection.from, to: selection.to }, text }))
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const target = event.target
      if (!(target instanceof Node)) return
      const view = viewRef.current
      const barHasFocus = barRef.current?.contains(target) ?? false
      const editorHasFocus = view?.dom.contains(target) ?? false
      if (!barHasFocus && !editorHasFocus) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        if (view && editorHasFocus) seedFromSelection(view)
        // Opening focuses the field by itself once the bar renders.
        if (isOpen) setFocusRequest({ target: 'find' })
        else onOpen()
        return
      }

      if (canReplace && event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault()
        event.stopPropagation()
        const seeded = view && editorHasFocus ? seedFromSelection(view) : false
        setIsReplaceOpen(true)
        // With nothing to look for yet, the find field comes first.
        setFocusRequest({ target: seeded || query ? 'replace' : 'find' })
        if (!isOpen) onOpen()
        return
      }

      if (!isOpen) return

      // Enter only navigates from the find field; in the editor it keeps its default behavior (line break).
      if (target === inputRef.current && event.key === 'Enter' && !(event.ctrlKey || event.metaKey || event.altKey)) {
        event.preventDefault()
        event.stopPropagation()
        navigate(event.shiftKey ? -1 : 1)
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [canReplace, isOpen, navigate, onOpen, query, seedFromSelection, viewRef])

  const close = () => {
    setSearchScope(null)
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
        <div ref={barRef} className="rw-editor-search-bar" role="search" aria-label={t('editorSearch.label')}>
          {canReplace ? (
            <IconButton
              className={`rw-editor-search-toggle${isReplaceOpen ? ' rw-editor-search-toggle--open' : ''}`}
              icon={<ChevronRightIcon size={13} />}
              label={t(isReplaceOpen ? 'editorSearch.hideReplace' : 'editorSearch.showReplace')}
              tooltipSide="bottom"
              aria-expanded={isReplaceOpen}
              onClick={() => setIsReplaceOpen((current) => !current)}
            />
          ) : (
            <SearchIcon size={14} className="rw-editor-search-input-icon" />
          )}
          <div className="rw-editor-search-rows">
            <div className="rw-editor-search-field">
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
            </div>
            <div className="rw-editor-search-actions">
              <span className={`rw-editor-search-count${result.invalidRegularExpression ? ' rw-editor-search-count--invalid' : ''}`} aria-live="polite">
                {resultLabel}
              </span>
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
                className="rw-editor-search-scope"
                icon={<SelectionIcon size={13} />}
                label={t('editorSearch.inSelection')}
                tooltipSide="bottom"
                aria-pressed={scope !== null}
                onClick={toggleSearchScope}
              />
              <IconButton
                icon={<CloseIcon size={13} />}
                label={t('editorSearch.close')}
                tooltipSide="bottom"
                onClick={close}
              />
            </div>
            {canReplace && isReplaceOpen && (
              <>
                <div className="rw-editor-search-field">
                  <input
                    ref={replaceInputRef}
                    type="text"
                    value={replacement}
                    className="rw-editor-search-input"
                    aria-label={t('editorSearch.replaceInputLabel')}
                    placeholder={t('editorSearch.replacePlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setReplacement(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        close()
                      } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        const hasCommandKey = event.ctrlKey || event.metaKey
                        if (hasCommandKey && event.altKey) replaceAll()
                        else if (!hasCommandKey && !event.altKey) replaceCurrent()
                      }
                    }}
                  />
                  <SearchOptionButton
                    label={t('editorSearch.preserveCase')}
                    pressed={preserveCase}
                    onClick={() => setPreserveCase((current) => !current)}
                  >
                    AB
                  </SearchOptionButton>
                </div>
                <div className="rw-editor-search-actions">
                  <Tooltip label={t('editorSearch.replace')} side="bottom">
                    <IconButton
                      icon={<ReplaceIcon size={14} />}
                      label={t('editorSearch.replace')}
                      tooltip={false}
                      disabled={result.matches.length === 0}
                      onClick={replaceCurrent}
                    />
                  </Tooltip>
                  <Tooltip label={t('editorSearch.replaceAll')} side="bottom">
                    <IconButton
                      icon={<ReplaceAllIcon size={14} />}
                      label={t('editorSearch.replaceAll')}
                      tooltip={false}
                      disabled={result.matches.length === 0}
                      onClick={replaceAll}
                    />
                  </Tooltip>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
