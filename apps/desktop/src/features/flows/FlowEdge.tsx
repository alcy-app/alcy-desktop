import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { useTooltip } from '../../shared/ui/use-tooltip'
import type { FlowEdgeType } from './flow-edge-types'

function roundedReturn(points: [number, number][]) {
  let path = `M ${points[0].join(',')}`
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1], corner = points[index], next = points[index + 1]
    const incoming = Math.hypot(corner[0] - previous[0], corner[1] - previous[1])
    const outgoing = Math.hypot(next[0] - corner[0], next[1] - corner[1])
    if (!incoming || !outgoing) { path += ` L ${corner.join(',')}`; continue }
    const radius = Math.min(4, incoming / 2, outgoing / 2)
    const before = corner.map((value, axis) => value - (value - previous[axis]) / incoming * radius)
    const after = corner.map((value, axis) => value + (next[axis] - value) / outgoing * radius)
    path += ` L ${before.join(',')} Q ${corner.join(',')} ${after.join(',')}`
  }
  return `${path} L ${points[points.length - 1].join(',')}`
}

/** Neutral orthogonal wiring with execution trails
 * and a delete action on hover. React Flow owns hover detection because a
 * separate transparent SVG path does not reliably receive hits in WebKitGTK. */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps<FlowEdgeType>) {
  const { t } = useLanguage()
  const deleteTooltip = useTooltip(t('flows.canvas.deleteEdgeAria'))

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
    borderRadius: 4,
    offset: 32,
  })
  const sourceLane = data?.sourceLaneX ?? sourceX + 24
  const targetLane = data?.targetLaneX ?? targetX - 24
  const path = data?.outsideY === undefined ? edgePath : roundedReturn([[sourceX, sourceY], [sourceLane, sourceY], [sourceLane, data.outsideY], [targetLane, data.outsideY], [targetLane, targetY], [targetX, targetY]])
  const deleteX = data?.outsideY === undefined ? labelX : (sourceLane + targetLane) / 2
  const deleteY = data?.outsideY ?? labelY

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        className={[
          data?.active ? 'flow-edge--active' : data?.traversed ? 'flow-edge--traversed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      />

      {data?.hovered && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="nodrag nopan flow-edge-delete"
            style={{ transform: `translate(-50%, -50%) translate(${deleteX}px, ${deleteY}px)` }}
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
