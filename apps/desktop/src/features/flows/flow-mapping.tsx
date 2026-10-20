import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, FocusEvent, DragEvent } from 'react'
import { EditorView } from '@codemirror/view'
import { createPortal } from 'react-dom'
import { FlowMappingContext as Context, FLOW_REFERENCE_MIME } from './flow-reference'
import { useLanguage } from '../../shared/i18n/use-language'
import { cancelFlowOutputQuery, inspectFlowOutput } from '../../bindings/inspect-flow-output'
import { referenceFromPointer } from './flow-reference'

export interface FlowReferenceSource { nodeId: string; snapshotNodeId?: string; label: string; scope: 'request' | 'response' }

function inputTarget(element: Element | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  element = element?.closest('.cm-content') ?? element
  if (element?.closest('[data-flow-map]')?.getAttribute('data-flow-map') === 'false' || element?.id.startsWith('header-name-')) return null
  if (element instanceof HTMLTextAreaElement) return element
  if (element instanceof HTMLInputElement && ['text', 'url', 'search'].includes(element.type) && element.type !== 'search') return element
  if (element instanceof HTMLElement && (element.isContentEditable || element.getAttribute('contenteditable') === 'true')) return element
  return null
}

export function FlowMappingProvider({ children, onInsert, references = [], scopeKey = '', onTargetNodeChange, sources = [], rootPath = '', flowExecutionId = null }: { children: ReactNode; onInsert?: () => void; references?: string[]; scopeKey?: string; onTargetNodeChange?: (nodeId: string) => void; sources?: FlowReferenceSource[]; rootPath?: string; flowExecutionId?: string | null }) {
  const { t } = useLanguage()
  const target = useRef<{ element: HTMLElement; start: number; end: number; scope: string } | null>(null)
  const [targetScope, setTargetScope] = useState<string | null>(null)
  const hasTarget = targetScope !== null && targetScope === scopeKey
  const [discovered, setDiscovered] = useState(new Map<string, string>())
  const registerReferences = useCallback((items: string[]) => {
    setDiscovered((current) => {
      let next = current
      for (const item of items) {
        if (next.get(item) === scopeKey) continue
        if (next === current) next = new Map(current)
        if (!next.has(item) && next.size >= 1000) next.delete(next.keys().next().value ?? '')
        next.set(item, scopeKey)
      }
      return next
    })
  }, [scopeKey])
  const [suggestions, setSuggestions] = useState<{ items: string[]; query: string; scope: string; index: number; from: number; to: number; left: number; top: number } | null>(null)
  const query = suggestions?.query
  const sourceKey = JSON.stringify(sources)
  useEffect(() => {
    if (query === undefined || !flowExecutionId) return
    const available = JSON.parse(sourceKey) as FlowReferenceSource[]
    const exact = available.filter((source) => query.startsWith(`nodes.${source.nodeId}.`))
    const candidates = exact.length ? exact : available.filter((source) => !query.startsWith('nodes.') || `nodes.${source.nodeId}.`.includes(query)).sort((a, b) => Number(b.label.toLowerCase().includes(query)) - Number(a.label.toLowerCase().includes(query)))
    let obsolete = false
    const ids: string[] = []
    const timer = window.setTimeout(() => {
      void Promise.all(candidates.slice(0, 3).map(async (source) => {
        const prefix = `nodes.${source.nodeId}.${source.scope}.body`
        const tail = query.startsWith(`${prefix}.`) ? query.slice(prefix.length + 1).split('.') : []
        const filter = tail.length ? tail.pop() ?? '' : query && !prefix.toLowerCase().includes(query) && !source.label.toLowerCase().includes(query) ? query : ''
        const pointer = tail.length ? `/${tail.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : ''
        const queryId = crypto.randomUUID()
        ids.push(queryId)
        try {
          const result = await inspectFlowOutput({ rootPath, flowExecutionId, nodeId: source.snapshotNodeId ?? source.nodeId, queryId, pointer, query: filter })
          return result.page?.entries.flatMap((entry) => { const reference = referenceFromPointer(source.nodeId, entry.pointer, source.scope); return reference ? [reference] : [] }) ?? []
        } catch { return [] }
      })).then((pages) => {
        if (obsolete) return
        const fields = pages.flat()
        registerReferences(fields)
        setSuggestions((current) => current?.query === query && current.scope === scopeKey ? { ...current, items: [...new Set([...current.items, ...fields])].slice(0, 12) } : current)
      })
    }, 120)
    return () => { obsolete = true; window.clearTimeout(timer); for (const id of ids) void cancelFlowOutputQuery(id).catch(() => undefined) }
  }, [query, sourceKey, flowExecutionId, rootPath, scopeKey, registerReferences])
  const remember = (element: HTMLElement) => {
    const field = inputTarget(element)
    if (!field || field.closest('[data-flow-source]') || !field.closest('[data-flow-fields]')) return
    const scope = field.closest('[data-flow-node-id]')?.getAttribute('data-flow-node-id') ?? scopeKey
    target.current = { element: field, scope, start: field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.selectionStart ?? field.value.length : 0, end: field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.selectionEnd ?? field.value.length : 0 }
    setTargetScope(scope)
    if (scope !== scopeKey) onTargetNodeChange?.(scope)
  }
  const onFocus = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) { remember(event.target); const element = event.target; requestAnimationFrame(() => suggest(element)) }
  }
  const insert = useCallback((reference: string, expectedScope = scopeKey): boolean => {
    const saved = target.current
    if (!saved?.element.isConnected || saved.scope !== expectedScope || !reference.startsWith('{{') || !reference.endsWith('}}') || reference.length > 8192) return false
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
    insert(reference, field.closest('[data-flow-node-id]')?.getAttribute('data-flow-node-id') ?? scopeKey)
  }
  const suggest = (element: HTMLElement, explicit = false) => {
    if (!element.closest('[data-flow-fields]')) return
    const field = inputTarget(element)
    if (!field) return
    if (document.activeElement !== field && !field.contains(document.activeElement)) return
    const view = field.isContentEditable || field.getAttribute('contenteditable') === 'true' ? EditorView.findFromDOM(field) : null
    const text = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : view?.state.doc.toString() ?? ''
    const position = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.selectionStart ?? text.length : view?.state.selection.main.head ?? 0
    const start = text.lastIndexOf('{{', position)
    const inToken = start >= 0 && position >= start + 2 && !text.slice(start + 2, position).includes('}')
    if (!inToken && !explicit) { setSuggestions(null); return }
    const query = inToken ? text.slice(start + 2, position).trim() : ''
    const needle = query.toLowerCase()
    const items = [...new Set([...references, ...[...discovered].filter(([reference, owner]) => reference.startsWith('{{nodes.') ? references.some((allowed) => reference.startsWith(allowed.slice(0, -2))) : owner === scopeKey).map(([reference]) => reference)])].filter((reference) => reference.toLowerCase().includes(needle) || sources.some((source) => reference.startsWith(`{{nodes.${source.nodeId}.`) && source.label.toLowerCase().includes(needle))).slice(0, 12)
    const close = inToken ? text.indexOf('}}', position) : -1
    const bounds = field.getBoundingClientRect()
    remember(field)
    setSuggestions({ items, query, scope: field.closest('[data-flow-node-id]')?.getAttribute('data-flow-node-id') ?? scopeKey, index: 0, from: inToken ? start : position, to: close < 0 ? position : close + 2, left: Math.max(8, Math.min(bounds.left, window.innerWidth - 420)), top: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 300)) })
  }
  const complete = (reference: string) => {
    if (!suggestions || !target.current) return
    const field = target.current.element
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.setSelectionRange(suggestions.from, suggestions.to)
    else { const view = EditorView.findFromDOM(field); view?.dispatch({ selection: { anchor: suggestions.from, head: suggestions.to } }) }
    insert(reference)
  }
  return <Context.Provider value={{ insert, hasTarget, registerReferences, references: [...references, ...[...discovered].filter(([reference, owner]) => reference.startsWith('{{nodes.') ? references.some((allowed) => reference.startsWith(allowed.slice(0, -2))) : owner === scopeKey).map(([reference]) => reference)] }}>
    <div className="flow-mapping-surface" onFocusCapture={onFocus} onBlurCapture={() => setSuggestions(null)} onInputCapture={(event) => { const element = event.target; if (element instanceof HTMLElement) requestAnimationFrame(() => suggest(element)) }} onKeyDownCapture={(event) => {
      if (event.code === 'Space' && (event.ctrlKey || event.metaKey) && event.target instanceof HTMLElement && inputTarget(event.target)?.closest('[data-flow-fields]')) { event.preventDefault(); event.stopPropagation(); suggest(event.target, true); return }
      if (!suggestions || suggestions.scope !== scopeKey) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSuggestions(null) }
      if (suggestions.items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); event.stopPropagation(); setSuggestions({ ...suggestions, index: (suggestions.index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.items.length) % suggestions.items.length }) }
      if (suggestions.items.length && (event.key === 'Enter' || event.key === 'Tab')) { event.preventDefault(); event.stopPropagation(); complete(suggestions.items[suggestions.index]) }
    }} onKeyUpCapture={(event) => { if (event.target instanceof HTMLElement) { remember(event.target); if (!['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Control', 'Meta', ' '].includes(event.key)) suggest(event.target) } }} onPointerUpCapture={(event) => { if (event.target instanceof HTMLElement) { remember(event.target); suggest(event.target) } }} onDragOver={(event) => { if (event.dataTransfer.types.includes(FLOW_REFERENCE_MIME)) event.preventDefault() }} onDrop={drop}>
      {children}
      {suggestions && suggestions.scope === scopeKey && createPortal(<div className="flow-reference-suggestions" data-flow-reference-options style={{ left: suggestions.left, top: suggestions.top }} onPointerDown={(event) => event.stopPropagation()}>
        <div className="flow-reference-suggestions-heading">{t('flows.studio.autocompleteHint')}</div>
        <div className="flow-reference-options" role="listbox" aria-label={t('flows.studio.fields')}>
          {suggestions.items.map((reference, index) => <div key={reference} role="option" aria-label={reference} aria-selected={index === suggestions.index} onMouseEnter={() => setSuggestions({ ...suggestions, index })} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); complete(reference) }} onClick={() => complete(reference)}><span>{sources.find((source) => reference.startsWith(`{{nodes.${source.nodeId}.`))?.label ?? t('flows.studio.variables')}</span><code>{reference}</code></div>)}
          {suggestions.items.length === 0 && <p className="flow-studio-empty">{t('flows.studio.noFields')}</p>}
        </div>
      </div>, document.body)}
    </div>
  </Context.Provider>
}
