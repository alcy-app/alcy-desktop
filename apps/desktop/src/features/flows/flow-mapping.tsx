import { useCallback, useRef, useState } from 'react'
import type { ReactNode, FocusEvent, DragEvent } from 'react'
import { EditorView } from '@codemirror/view'
import { createPortal } from 'react-dom'
import { FlowMappingContext as Context, FLOW_REFERENCE_MIME } from './flow-reference'
import { useLanguage } from '../../shared/i18n/use-language'

function inputTarget(element: Element | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (element?.closest('[data-flow-map]')?.getAttribute('data-flow-map') === 'false' || element?.id.startsWith('header-name-')) return null
  if (element instanceof HTMLTextAreaElement) return element
  if (element instanceof HTMLInputElement && ['text', 'url', 'search'].includes(element.type) && element.type !== 'search') return element
  if (element instanceof HTMLElement && element.isContentEditable) return element
  return null
}

export function FlowMappingProvider({ children, onInsert, references = [], scopeKey = '' }: { children: ReactNode; onInsert?: () => void; references?: string[]; scopeKey?: string }) {
  const { t } = useLanguage()
  const target = useRef<{ element: HTMLElement; start: number; end: number; scope: string } | null>(null)
  const [targetScope, setTargetScope] = useState<string | null>(null)
  const hasTarget = targetScope !== null && targetScope === scopeKey
  const discovered = useRef(new Map<string, string>())
  const registerReferences = useCallback((items: string[]) => {
    for (const item of items) { if (!discovered.current.has(item) && discovered.current.size >= 1000) discovered.current.delete(discovered.current.keys().next().value ?? ''); discovered.current.set(item, scopeKey) }
  }, [scopeKey])
  const [suggestions, setSuggestions] = useState<{ items: string[]; index: number; from: number; to: number; left: number; top: number } | null>(null)
  const remember = (element: HTMLElement) => {
    const field = inputTarget(element)
    if (!field || field.closest('[data-flow-source]') || !field.closest('[data-flow-fields]')) return
    target.current = { element: field, scope: scopeKey, start: field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.selectionStart ?? field.value.length : 0, end: field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.selectionEnd ?? field.value.length : 0 }
    setTargetScope(scopeKey)
  }
  const onFocus = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) remember(event.target)
  }
  const insert = useCallback((reference: string): boolean => {
    const saved = target.current
    if (!saved?.element.isConnected || saved.scope !== scopeKey || !reference.startsWith('{{') || !reference.endsWith('}}') || reference.length > 8192) return false
    const field = saved.element
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      const start = field.selectionStart ?? saved.start
      const end = field.selectionEnd ?? saved.end
      const next = field.value.slice(0, start) + reference + field.value.slice(end)
      const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, next)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.focus()
      field.setSelectionRange(start + reference.length, start + reference.length)
    } else {
      const view = EditorView.findFromDOM(field)
      if (!view) return false
      view.dispatch(view.state.replaceSelection(reference))
      view.focus()
    }
    onInsert?.()
    requestAnimationFrame(() => { if (field.isConnected) field.focus() })
    setSuggestions(null)
    return true
  }, [onInsert, scopeKey])
  const drop = (event: DragEvent) => {
    const reference = event.dataTransfer.getData(FLOW_REFERENCE_MIME)
    const field = event.target instanceof Element ? inputTarget(event.target) : null
    if (!reference || !field || !field.closest('[data-flow-fields]')) return
    event.preventDefault()
    event.stopPropagation()
    remember(field)
    insert(reference)
  }
  const suggest = (element: HTMLElement) => {
    if (!element.closest('[data-flow-fields]')) return
    const field = inputTarget(element)
    if (!field) return
    const view = field.isContentEditable ? EditorView.findFromDOM(field) : null
    const text = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : view?.state.doc.toString() ?? ''
    const position = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.selectionStart ?? text.length : view?.state.selection.main.head ?? 0
    const start = text.lastIndexOf('{{', position)
    if (start < 0 || text.slice(start + 2, position).includes('}')) { setSuggestions(null); return }
    const query = text.slice(start + 2, position).toLowerCase()
    const items = [...new Set([...references, ...[...discovered.current].filter(([reference, owner]) => reference.startsWith('{{nodes.') ? references.some((allowed) => reference.startsWith(allowed.slice(0, -2))) : owner === scopeKey).map(([reference]) => reference)])].filter((reference) => reference.toLowerCase().includes(query)).slice(0, 8)
    if (!items.length) { setSuggestions(null); return }
    const bounds = field.getBoundingClientRect()
    remember(field)
    setSuggestions({ items, index: 0, from: start, to: position + (text.slice(position, position + 2) === '}}' ? 2 : 0), left: Math.max(8, Math.min(bounds.left, window.innerWidth - 380)), top: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 280)) })
  }
  const complete = (reference: string) => {
    if (!suggestions || !target.current) return
    const field = target.current.element
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.setSelectionRange(suggestions.from, suggestions.to)
    else { const view = EditorView.findFromDOM(field); view?.dispatch({ selection: { anchor: suggestions.from, head: suggestions.to } }) }
    insert(reference)
  }
  return <Context.Provider value={{ insert, hasTarget, registerReferences }}>
    <div className="flow-mapping-surface" onFocusCapture={onFocus} onBlurCapture={() => setSuggestions(null)} onInputCapture={(event) => { const element = event.target; if (element instanceof HTMLElement) requestAnimationFrame(() => suggest(element)) }} onKeyDownCapture={(event) => {
      if (!suggestions) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSuggestions(null) }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setSuggestions({ ...suggestions, index: (suggestions.index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.items.length) % suggestions.items.length }) }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); complete(suggestions.items[suggestions.index]) }
    }} onKeyUpCapture={(event) => { if (event.target instanceof HTMLElement) remember(event.target) }} onPointerUpCapture={(event) => { if (event.target instanceof HTMLElement) remember(event.target) }} onDragOver={(event) => { if (event.dataTransfer.types.includes(FLOW_REFERENCE_MIME)) event.preventDefault() }} onDrop={drop}>
      {children}
      {suggestions && createPortal(<div className="flow-reference-suggestions" role="listbox" aria-label={t('flows.studio.fields')} style={{ left: suggestions.left, top: suggestions.top }}>{suggestions.items.map((reference, index) => <button key={reference} type="button" role="option" aria-selected={index === suggestions.index} onMouseDown={(event) => event.preventDefault()} onClick={() => complete(reference)}>{reference}</button>)}</div>, document.body)}
    </div>
  </Context.Provider>
}
