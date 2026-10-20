import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import type { RequestSummary, TreeNode } from '../request-workbench/collection-tree'
import { RequestPicker } from './RequestPicker'

/** The endpoint opens request selection without selecting or dragging its canvas node. */
export function RequestEndpoint({ children, url, collections, onSelectRequest, readOnly = false, configured = true }: { children: ReactNode; url?: string; collections: TreeNode[]; onSelectRequest: (request: RequestSummary) => void; readOnly?: boolean; configured?: boolean }) {
  const { t } = useLanguage()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const close = () => { setAnchor(null); triggerRef.current?.focus({ preventScroll: true }) }
  if (readOnly) return <span className="flow-node-request-summary">{children}</span>
  return <span onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button ref={triggerRef} type="button" className="flow-node-request-summary flow-node-request-picker nodrag nopan" aria-label={t(configured ? 'flows.canvas.changeRequestAria' : 'flows.canvas.chooseRequestLabel')} aria-haspopup="listbox" aria-expanded={anchor !== null} title={url} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setAnchor(event.currentTarget.getBoundingClientRect()) }}>{children}</button>
    {anchor && <RequestPicker anchor={anchor} collections={collections} onClose={close} onSelectRequest={(request) => { onSelectRequest(request); close() }} />}
  </span>
}
