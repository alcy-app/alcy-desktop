import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../../shared/i18n/use-language'
import { Field } from '../../shared/ui/Field'
import { IconButton } from '../../shared/ui/IconButton'
import { Textarea } from '../../shared/ui/Textarea'
import { CloseIcon, FormatIcon } from '../../shared/ui/icons'
import type { ConditionState, SimpleNodeKindState } from './flows.types'
import { AssignmentFields, ConditionFields, SleepFields } from './NodeInspectorPanel'

type QuickConfig = SimpleNodeKindState | { kind: 'if'; condition: ConditionState }

export function QuickNodeEdit({ config, onChange }: { config: QuickConfig; onChange: (config: QuickConfig) => void }) {
  const { t } = useLanguage()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLSpanElement | null>(null)
  const close = () => { setAnchor(null); trigger.current?.querySelector('button')?.focus() }
  useEffect(() => {
    if (!anchor) return
    popover.current?.querySelector<HTMLElement>('input, textarea, select')?.focus()
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !popover.current?.contains(event.target) && !trigger.current?.contains(event.target)) setAnchor(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAnchor(null); trigger.current?.querySelector('button')?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [anchor])
  if (!['sleep', 'log', 'display', 'setVariables', 'if', 'while'].includes(config.kind)) return null
  return <span className="nodrag" ref={trigger} onDoubleClick={(event) => event.stopPropagation()}>
    <IconButton icon={<FormatIcon size={12} />} label={t('flows.studio.quickEdit')} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect()) }} />
    {anchor && createPortal(<div ref={popover} className="flow-quick-editor" role="dialog" aria-label={t('flows.studio.quickEdit')} data-flow-fields style={{ left: Math.max(12, Math.min(anchor.left, window.innerWidth - 352)), top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - 340)) }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div className="flow-quick-heading">{t('flows.studio.quickEdit')}<IconButton icon={<CloseIcon size={12} />} label={t('common.close')} onClick={close} /></div>
      {config.kind === 'sleep' && <SleepFields durationMs={config.durationMs} onChange={(durationMs) => onChange({ ...config, durationMs })} />}
      {(config.kind === 'if' || config.kind === 'while') && <ConditionFields condition={config.condition} onChange={(condition) => onChange({ ...config, condition })} />}
      {config.kind === 'setVariables' && <AssignmentFields assignments={config.assignments} onChange={(assignments) => onChange({ ...config, assignments })} />}
      {(config.kind === 'log' || config.kind === 'display') && <Field label={t(config.kind === 'log' ? 'flows.canvas.logMessageLabel' : 'flows.canvas.displayTemplateLabel')}><Textarea mono rows={5} value={config.kind === 'log' ? config.message : config.template} onChange={(event) => onChange(config.kind === 'log' ? { ...config, message: event.target.value } : { ...config, template: event.target.value })} /></Field>}
    </div>, document.body)}
  </span>
}
