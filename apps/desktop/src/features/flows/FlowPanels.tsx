import { useRef, useState } from 'react'
import type { ReactNode, PointerEvent } from 'react'
import type { FlowPanel, FlowPresentation } from '../../bindings/flow-forms'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Input } from '../../shared/ui/Input'
import { Badge } from '../../shared/ui/Badge'
import type { FlowNodeState } from './flows.types'
import type { NodeRunStatus } from './use-flow-run'
import { describeRunStatus } from './node-run-status'
import './flow-panels.css'

export function FlowPanels({ nodes, presentation, onChange, statuses, renderContent }: { nodes: FlowNodeState[]; presentation: FlowPresentation; onChange: (presentation: FlowPresentation) => void; statuses: Record<string, NodeRunStatus>; renderContent: (node: FlowNodeState) => ReactNode }) {
  const { t } = useLanguage()
  const [arranging, setArranging] = useState(false)
  const eligible = nodes.filter((node) => node.kind === 'display' || node.kind === 'humanAction' || (node.kind === 'start' && node.form))
  const panels = presentation.panels.filter((panel) => eligible.some((node) => node.id === panel.nodeId))
  const title = (node: FlowNodeState) => (node.kind === 'humanAction' || node.kind === 'start' ? node.form?.title : '') || node.id
  const update = (panel: FlowPanel) => onChange({ panels: presentation.panels.map((p) => p.nodeId === panel.nodeId ? panel : p) })
  return <section className="flow-panels" aria-label={t('flows.panels.panels')}>
    <div className="flow-panels-tools"><Button size="sm" variant={arranging ? 'primary' : 'ghost'} onClick={() => setArranging((value) => !value)}>{t(arranging ? 'flows.panels.done' : 'flows.panels.organize')}</Button></div>
    {(arranging || panels.length === 0) && <div className="flow-panels-chooser"><strong>{t('flows.panels.choose')}</strong>{eligible.map((node, index) => <label key={node.id} className="flow-form-check"><Checkbox checked={panels.some((p) => p.nodeId === node.id)} onChange={(e) => onChange({ panels: e.target.checked ? [...presentation.panels, { nodeId: node.id, title: '', x: (index % 2) * 460 + 16, y: Math.floor(index / 2) * 420 + 16, width: 440, height: 400 }] : presentation.panels.filter((p) => p.nodeId !== node.id) })} />{title(node)}</label>)}{eligible.length === 0 && <p>{t('flows.panels.empty')}</p>}</div>}
    <div className="flow-panels-scroll"><div className="flow-panels-board" style={{ minWidth: Math.max(320, ...panels.map((p) => p.x + p.width + 16)), minHeight: Math.max(400, ...panels.map((p) => p.y + p.height + 16)) }}>
      {panels.length === 0 && <p className="flow-panels-empty">{t('flows.panels.empty')}</p>}
      {panels.map((panel) => {
        const node = eligible.find((n) => n.id === panel.nodeId)
        if (!node) return null
        const chip = describeRunStatus(statuses[node.id] ?? { status: 'idle' }, t)
        return <PanelCard key={panel.nodeId} panel={panel} onChange={update} arranging={arranging} title={title(node)} badge={<Badge tone={chip?.tone ?? 'neutral'}>{chip?.label ?? t('flows.panels.idle')}</Badge>}>
          {renderContent(node)}
        </PanelCard>
      })}
    </div></div>
  </section>
}

function PanelCard({ panel, title, badge, children, arranging, onChange }: { panel: FlowPanel; title: string; badge: ReactNode; children: ReactNode; arranging: boolean; onChange: (panel: FlowPanel) => void }) {
  const { t } = useLanguage()
  const [preview, setPreview] = useState<FlowPanel | null>(null)
  const current = preview ?? panel
  const gesture = useRef<{ x: number; y: number; panel: FlowPanel; resize: boolean; next: FlowPanel } | null>(null)
  const start = (event: PointerEvent<HTMLElement>, resize: boolean) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { x: event.clientX, y: event.clientY, panel, resize, next: panel }
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const drag = gesture.current
    if (!drag) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    drag.next = drag.resize ? { ...drag.panel, width: Math.min(4096, Math.max(280, drag.panel.width + dx)), height: Math.min(4096, Math.max(180, drag.panel.height + dy)) } : { ...drag.panel, x: Math.min(100000, Math.max(0, drag.panel.x + dx)), y: Math.min(100000, Math.max(0, drag.panel.y + dy)) }
    setPreview(drag.next)
  }
  const finish = () => { const drag = gesture.current; gesture.current = null; setPreview(null); if (drag) onChange(drag.next) }
  const arrows = (event: React.KeyboardEvent<HTMLElement>, resize: boolean) => {
    const dx = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0
    const dy = event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0
    if (!dx && !dy) return
    event.preventDefault()
    onChange(resize ? { ...panel, width: Math.min(4096, Math.max(280, panel.width + dx)), height: Math.min(4096, Math.max(180, panel.height + dy)) } : { ...panel, x: Math.min(100000, Math.max(0, panel.x + dx)), y: Math.min(100000, Math.max(0, panel.y + dy)) })
  }
  return <article className={`flow-panel-card${arranging ? ' flow-panel-card--arranging' : ''}`} style={{ left: current.x, top: current.y, width: current.width, height: current.height }} aria-label={panel.title || title}>
    <header className="flow-panel-header">
      {arranging ? <><button className="flow-panel-move" type="button" aria-label={`${title}: ${t('flows.panels.move')}`} onPointerDown={(e) => start(e, false)} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { gesture.current = null; setPreview(null) }} onKeyDown={(e) => arrows(e, false)}>⠿</button><Input aria-label={t('flows.forms.title')} value={panel.title} placeholder={title} maxLength={1024} onChange={(e) => onChange({ ...panel, title: e.target.value })} /></> : <strong>{panel.title || title}</strong>}{badge}
    </header>
    <div className="flow-panel-content">{children}</div>
    {arranging && <button type="button" className="flow-panel-resize" aria-label={`${title}: ${t('flows.panels.resize')}`} onPointerDown={(e) => start(e, true)} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { gesture.current = null; setPreview(null) }} onKeyDown={(e) => arrows(e, true)}>↘</button>}
  </article>
}
