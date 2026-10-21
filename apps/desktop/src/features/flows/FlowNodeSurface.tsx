import { useCallback, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import { NodeToolbar, Position, useInternalNode, useNodeId, useViewport } from '@xyflow/react'

interface Props {
  size: { width: number; height: number }
  handles?: ReactNode
  className?: string
  onDoubleClick?: () => void
  /** Right-click on the click-through chassis, which owns the node footprint. */
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void
  /** Reuse the caller's ref to forward presses from screen-space content to the chassis. */
  chassisRef?: RefObject<HTMLDivElement | null>
  children: ReactNode
}

/** Keep the draggable chassis and handles in graph coordinates; paint interactive content in screen space using layout zoom. */
export function FlowNodeSurface({ size, handles, className = '', onDoubleClick, onContextMenu, chassisRef: externalChassisRef, children }: Props) {
  const nodeId = useNodeId()
  const node = useInternalNode(nodeId ?? '')
  const { zoom } = useViewport()
  const internalChassisRef = useRef<HTMLDivElement>(null)
  const chassisRef = externalChassisRef ?? internalChassisRef
  const observerRef = useRef<ResizeObserver | null>(null)
  const [hovered, setHovered] = useState(false)
  const measure = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element || !nodeId) return
    const update = () => {
      const chassis = chassisRef.current
      if (!chassis) return
      // offset dimensions are logical CSS pixels even when the content uses layout zoom.
      if (element.offsetWidth > 0) chassis.style.width = `${element.offsetWidth}px`
      if (element.offsetHeight > 0) chassis.style.height = `${element.offsetHeight}px`
    }
    update()
    if (typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(update)
      observerRef.current.observe(element)
    }
  }, [nodeId, chassisRef])

  // Standalone previews have no node identity or graph portal target.
  if (!nodeId) return <div className={`flow-node-chassis flow-node-preview ${className}`} style={size} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}>{children}{handles}</div>
  const width = node?.measured?.width ?? size.width
  const height = node?.measured?.height ?? size.height
  const classes = ['flow-node-presentation', node?.className, node?.selected ? 'flow-node-presentation--selected' : '', hovered ? 'flow-node-presentation--hovered' : ''].filter(Boolean).join(' ')
  return <>
    <div ref={chassisRef} className={`flow-node-chassis ${className}`} style={{ width: size.width, height: size.height }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}>{handles}</div>
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Right} align="start" offset={-width * zoom} className={classes} style={{ zIndex: node?.selected ? 4 : 3, width: width * zoom, height: height * zoom, pointerEvents: 'none' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div ref={measure} className="flow-node-content" style={{ zoom, pointerEvents: 'none' }}>{children}</div>
    </NodeToolbar>
  </>
}
