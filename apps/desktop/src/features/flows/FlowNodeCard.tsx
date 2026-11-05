import { Handle, Position } from '@xyflow/react'
import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { MenuItem, OptionsMenu } from '../../shared/ui/Menu'
import { AlertIcon } from '../../shared/ui/icons'
import { OverlayMotionContext } from '../../shared/ui/overlay-motion-context'
import type { FlowSourceHandle } from './flows.types'
import { NODE_KIND_APPEARANCE } from './node-kind-appearance'
import type { FlowNodeKind } from './node-kind-appearance'
import { describeRunStatus, runStateClass } from './node-run-status'
import type { NodeRunStatus } from './use-flow-run'
import { FlowNodeSurface } from './FlowNodeSurface'
import { startNodeDragFromChassis } from './flow-node-drag'
import { flowNodeSize } from './flow-geometry'

export type NodeOutputVariant = 'positive' | 'negative' | 'loop' | 'neutral'
export interface NodeOutput { id: FlowSourceHandle; label: string; variant: NodeOutputVariant; detail?: string }

interface FlowNodeCardProps {
  kind: FlowNodeKind
  title?: string
  subtitle?: string
  titleBadge?: ReactNode
  headerControls?: ReactNode
  runStatus?: NodeRunStatus
  visited?: boolean
  readOnly?: boolean
  compact?: boolean
  hasInput?: boolean
  outputs?: 'single' | 'none' | NodeOutput[]
  onOpenSettings?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  className?: string
  children?: ReactNode
}

/** Shared chassis with an overview body or a scrollable Display viewport. */
export function FlowNodeCard({ kind, title, subtitle, titleBadge, headerControls, runStatus = { status: 'idle' }, visited, readOnly, compact, hasInput = true, outputs = 'single', onOpenSettings, onDuplicate, onDelete, className, children }: FlowNodeCardProps) {
  const { t } = useLanguage()
  const [menuOpen, setMenuOpen] = useState(false)
  const [titlePointerInteraction, setTitlePointerInteraction] = useState(false)
  const chassisRef = useRef<HTMLDivElement>(null)
  const appearance = NODE_KIND_APPEARANCE[kind]
  const { Icon } = appearance
  const chip = describeRunStatus(runStatus, t)
  const resolvedTitle = title ?? t(appearance.titleKey)
  const summary = children === false || children === null || children === undefined ? subtitle ?? t(appearance.descriptionKey) : children
  const classes = ['flow-node', `flow-node--${kind}`, compact ? 'flow-node--compact' : '', runStateClass(runStatus, visited), className ?? ''].filter(Boolean).join(' ')
  const inputHandle = hasInput && <Handle type="target" position={Position.Left} className="flow-node-handle flow-node-handle--input" />
  const singleHandle = outputs === 'single' && <Handle type="source" position={Position.Right} className="flow-node-handle flow-node-handle--output flow-node-handle--header" />
  const handles = <>{inputHandle}{singleHandle}{Array.isArray(outputs) && outputs.map((output, index) => <Handle key={output.id} type="source" position={Position.Right} id={output.id} className="flow-node-handle flow-node-handle--output" style={{ top: `calc(var(--flow-node-header-height, 40px) + max(var(--flow-node-summary-height, 40px), calc(32px * var(--text-scale) + 8px)) + 1px + ${index + 0.5} * var(--flow-node-output-height, 24px))` }} />)}</>
  const hasActions = !readOnly && (onDuplicate !== undefined || onDelete !== undefined)
  // Right-click anywhere on the block opens the same actions menu as the three-dot trigger.
  const openActionsMenu = hasActions
    ? (event: ReactMouseEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); setMenuOpen(true) }
    : undefined
  return <OverlayMotionContext value={false}><FlowNodeSurface size={flowNodeSize(kind, Array.isArray(outputs) ? outputs.length : 0)} className={kind === 'start' ? 'flow-node-chassis--start' : ''} handles={handles} onContextMenu={openActionsMenu} chassisRef={chassisRef}><div className={classes} onContextMenu={openActionsMenu}>
    {hasInput && <span aria-hidden="true" className="flow-node-visual-handle flow-node-handle flow-node-handle--input" />}
    <div className="flow-node-header">
      <span className="flow-node-icon" aria-hidden="true"><Icon size={16} /></span>
      <div className="flow-node-heading">
        <div className="flow-node-title-row">
          {titleBadge}
          {!readOnly && onOpenSettings ? <button
            type="button"
            className="flow-node-title flow-node-title-button nopan"
            title={resolvedTitle}
            aria-label={t('flows.canvas.openNodeSettingsAria')}
            data-pointer-interaction={titlePointerInteraction || undefined}
            onPointerDown={() => setTitlePointerInteraction(true)}
            onKeyDown={() => setTitlePointerInteraction(false)}
            onBlur={() => setTitlePointerInteraction(false)}
            onMouseDown={(event) => { event.stopPropagation(); startNodeDragFromChassis(chassisRef.current, event) }}
            // A mouse click selects the block like a click anywhere on it (settings open on a double click); Enter/Space still open them.
            onClick={(event) => { if (event.detail !== 0) return; event.stopPropagation(); onOpenSettings() }}
          >{resolvedTitle}</button> : <span className="flow-node-title" title={resolvedTitle}>{resolvedTitle}</span>}
        </div>
        {compact && kind === 'start' && <span className="flow-node-subtitle">{subtitle ?? t(appearance.descriptionKey)}</span>}
      </div>
      {headerControls}
      {chip && <span className={`flow-node-run-chip flow-node-status--${chip.tone}`} title={[chip.label, chip.detail].filter(Boolean).join(' · ')}>{chip.label}</span>}
      {!readOnly && (onDuplicate || onDelete) && <div className="nodrag nopan" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <OptionsMenu label={t('flows.canvas.nodeActions')} isOpen={menuOpen} onToggle={() => setMenuOpen(!menuOpen)} onClose={() => setMenuOpen(false)} menuPortal menuPlacement="auto">
          {onOpenSettings && <MenuItem label={t('flows.canvas.manageNode')} onSelect={() => { setMenuOpen(false); onOpenSettings() }} />}
          {onDuplicate && <MenuItem label={t('flows.canvas.duplicateNodeAria')} onSelect={() => { setMenuOpen(false); onDuplicate() }} />}
          {onDelete && <MenuItem label={t('flows.canvas.deleteNodeAria')} danger onSelect={() => { setMenuOpen(false); onDelete() }} />}
        </OptionsMenu>
      </div>}
    </div>
    {!compact && <div className="flow-node-body">
      {runStatus.status === 'failed' ? <div className="flow-node-error" role="status" title={runStatus.message}><AlertIcon size={12} /><span className="flow-node-summary">{runStatus.message.slice(0, 240)}</span></div> : <div className="flow-node-summary">{summary}</div>}
    </div>}
    {Array.isArray(outputs) ? <div className="flow-node-outputs" aria-label={t('flows.canvas.nodeOutputsLabel')}>
      {outputs.map((output) => <div key={output.id} className={`flow-node-output flow-node-output--${output.variant}`}><span className="flow-node-output-label">{output.label}</span>{output.detail && <span className="flow-node-output-detail">{output.detail}</span>}<span aria-hidden="true" className="flow-node-visual-handle flow-node-handle flow-node-handle--output" /></div>)}
    </div> : outputs === 'single' && <span aria-hidden="true" className="flow-node-visual-handle flow-node-handle flow-node-handle--output flow-node-handle--header" />}
  </div></FlowNodeSurface></OverlayMotionContext>
}
