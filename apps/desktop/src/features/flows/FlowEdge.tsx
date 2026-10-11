import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { useTooltip } from '../../shared/ui/use-tooltip'
import type { TranslationKey } from '../../shared/i18n/translations'
import type { FlowEdgeType } from './flow-edge-types'
import { isFlowSourceHandle } from './flows.types'
import type { FlowSourceHandle } from './flows.types'

const BRANCH_LABEL_KEY: Record<FlowSourceHandle, TranslationKey> = {
  true: 'flows.canvas.ifTrueLabel',
  false: 'flows.canvas.ifFalseLabel',
  success: 'flows.canvas.requestSuccessLabel',
  failure: 'flows.canvas.requestFailureLabel',
  loop: 'flows.canvas.whileLoopLabel',
  done: 'flows.canvas.whileDoneLabel',
  iteration: 'flows.canvas.loadIterationLabel',
  passed: 'flows.canvas.loadThresholdPassedLabel',
  failed: 'flows.canvas.loadThresholdFailedLabel',
  body: 'flows.canvas.loadBodyLabel',
}

/** Edge customizada (registrada como o tipo `default`, então toda edge do
 * flow passa por aqui): mostra um "X" no meio da linha quando o mouse está
 * em cima dela, e anima um traço azul "andando" quando `data.active` (o
 * target dessa edge está com `runStatus === 'running'` durante um Run —
 * calculado em `FlowCanvas`). O hover é detectado pelo próprio xyflow
 * (`onEdgeMouseEnter`/`onEdgeMouseLeave` em `FlowCanvas`, viram `data.hovered`
 * aqui) — não por um `<path>` invisível próprio: um `stroke` "transparent"
 * nesse path não é tratado como pintado em todo motor de renderização
 * (WebKitGTK incluso), o que fazia o hover só "pegar" perto das pontas, onde
 * o traço visível de fato está sob o cursor. */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  markerEnd,
  style,
  data,
}: EdgeProps<FlowEdgeType>) {
  const { t } = useLanguage()
  const deleteTooltip = useTooltip(t('flows.canvas.deleteEdgeAria'))

  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  return (
    <>
      {(data?.traversed || data?.active) && <path className="flow-edge-glow" d={edgePath} />}
      {data?.traversed && <path className="flow-edge-comet" d={edgePath} pathLength={100} />}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        className={[
          isFlowSourceHandle(sourceHandleId) ? `flow-edge--branch-${sourceHandleId}` : '',
          data?.active ? 'flow-edge--active' : data?.traversed ? 'flow-edge--traversed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      />

      {isFlowSourceHandle(sourceHandleId) && (
        <EdgeLabelRenderer>
          <span
            className={`flow-edge-branch-label flow-edge-branch-label--${sourceHandleId}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 22}px)` }}
          >
            <span className="flow-edge-branch-dot" aria-hidden="true" />
            {t(BRANCH_LABEL_KEY[sourceHandleId])}
          </span>
        </EdgeLabelRenderer>
      )}

      {data?.hovered && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan flow-edge-delete"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            aria-label={t('flows.canvas.deleteEdgeAria')}
            {...deleteTooltip.triggerProps}
            onClick={() => data.onDelete()}
          />
          {deleteTooltip.tooltip}
        </EdgeLabelRenderer>
      )}
    </>
  )
}
