import type { CSSProperties } from 'react'

/** Shared chassis metrics used by CSS, insertion and graph layout. */
export const FLOW_GEOMETRY = { width: 256, displayWidth: 320, displayBody: 192, compactWidth: 160, header: 40, startHeight: 56, summary: 40, output: 24, columnGap: 96, rowGap: 32, grid: 16 } as const

export const flowGeometryStyle: CSSProperties & Record<string, string> = {
  '--flow-node-width': `${FLOW_GEOMETRY.width}px`,
  '--flow-display-width': `${FLOW_GEOMETRY.displayWidth}px`,
  '--flow-display-body-height': `${FLOW_GEOMETRY.displayBody}px`,
  '--flow-node-compact-width': `${FLOW_GEOMETRY.compactWidth}px`,
  '--flow-node-header-height': `${FLOW_GEOMETRY.header}px`,
  '--flow-node-start-height': `${FLOW_GEOMETRY.startHeight}px`,
  '--flow-node-summary-height': `${FLOW_GEOMETRY.summary}px`,
  '--flow-node-output-height': `${FLOW_GEOMETRY.output}px`,
}

export const snapFlowCoordinate = (value: number) => Math.round(value / FLOW_GEOMETRY.grid) * FLOW_GEOMETRY.grid

export function flowNodeSize(kind: string, outputCount = 0) {
  if (kind === 'start') return { width: FLOW_GEOMETRY.compactWidth, height: FLOW_GEOMETRY.startHeight }
  if (kind === 'display') return { width: FLOW_GEOMETRY.displayWidth, height: FLOW_GEOMETRY.header + FLOW_GEOMETRY.displayBody + 2 }
  if (kind === 'break' || kind === 'continue') return { width: FLOW_GEOMETRY.compactWidth, height: FLOW_GEOMETRY.header + 2 }
  return { width: FLOW_GEOMETRY.width, height: FLOW_GEOMETRY.header + FLOW_GEOMETRY.summary + outputCount * FLOW_GEOMETRY.output + (outputCount ? 3 : 2) }
}
