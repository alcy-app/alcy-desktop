import { useCallback, useLayoutEffect, useMemo, useRef, type TextareaHTMLAttributes } from 'react'
import { Textarea } from '../../shared/ui/Textarea'
import { parseTemplate } from '../request-workbench/template-highlight'
import { variableTokenClassName } from '../request-workbench/template-variables-codemirror'
import { useFlowMapping } from './flow-reference'
import '../request-workbench/components/template-highlight.css'
import './flow-template-textarea.css'

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue'> {
  value: string
  mono?: boolean
}

/** Keep native textarea editing and mirror its text using the request editor's variable styles. */
export function FlowTemplateTextarea({ value, mono, className, onScroll, ...props }: Props) {
  const { references } = useFlowMapping()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const segments = useMemo(() => parseTemplate(value), [value])
  const names = new Set(references.map((reference) => reference.slice(2, -2).trim()))
  const nodeRoots = [...names].filter((name) => name.startsWith('nodes.'))
  const syncOverlay = useCallback(() => {
    const input = inputRef.current
    const overlay = overlayRef.current
    if (!input || !overlay) return
    overlay.style.width = `${input.clientWidth}px`
    overlay.style.height = `${input.clientHeight}px`
    overlay.scrollTop = input.scrollTop
    overlay.scrollLeft = input.scrollLeft
  }, [])

  useLayoutEffect(() => {
    syncOverlay()
    const input = inputRef.current
    if (!input || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncOverlay)
    observer.observe(input)
    return () => observer.disconnect()
  }, [syncOverlay])
  useLayoutEffect(syncOverlay, [syncOverlay, value])

  return <div className="flow-template-field" data-wrap={props.wrap}>
    <Textarea {...props} ref={inputRef} mono={mono} value={value} className={['flow-template-input', className].filter(Boolean).join(' ')} onScroll={(event) => { syncOverlay(); onScroll?.(event) }} />
    <div ref={overlayRef} aria-hidden="true" className={['ui-textarea', mono && 'ui-textarea--mono', className, 'flow-template-overlay'].filter(Boolean).join(' ')}>
      {segments.map((segment, index) => segment.type === 'text' ? segment.value : <span key={index} className={variableTokenClassName(names.has(segment.name) || nodeRoots.some((root) => segment.name.startsWith(`${root}.`)))}>{segment.raw}</span>)}{'​'}
    </div>
  </div>
}
