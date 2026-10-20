import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Edge } from '@xyflow/react'
import type { FlowNode } from './flow-canvas-mapping'
import type { FlowPositions } from './flow-layout'
import { flowLayoutModel, layoutSignature } from './flow-layout-model'

/** Organization is cancellable and never runs graph traversal on the UI thread. */
export function useFlowLayout(nodes: FlowNode[], edges: Edge[], setNodes: Dispatch<SetStateAction<FlowNode[]>>, onOrganized: () => void, onError: () => void) {
  const graph = useMemo(() => flowLayoutModel(nodes, edges), [nodes, edges])
  const signature = layoutSignature(graph)
  const latest = useRef(signature)
  const worker = useRef<Worker | null>(null)
  const frame = useRef<number | null>(null)
  const [job, setJob] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ positions: FlowPositions; signature: string } | null>(null)
  if (undo && undo.signature !== signature) setUndo(null)

  useLayoutEffect(() => { latest.current = signature }, [signature])
  useEffect(() => {
    if (job && job !== signature) { worker.current?.terminate(); worker.current = null }
  }, [signature, job])
  useEffect(() => () => { worker.current?.terminate(); if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])

  const cancel = () => { worker.current?.terminate(); worker.current = null; setJob(null) }
  const organize = () => {
    cancel()
    try {
      const running = new Worker(new URL('./flow-layout.worker.ts', import.meta.url), { type: 'module' })
      worker.current = running
      setJob(signature)
      const fail = () => { if (worker.current !== running) return; cancel(); onError() }
      running.onerror = fail
      running.onmessage = (event: MessageEvent<{ positions?: FlowPositions; error?: boolean }>) => {
        if (worker.current !== running || latest.current !== signature) return
        if (event.data.error || !event.data.positions) { fail(); return }
        const positions = event.data.positions
        cancel()
        const next = graph.nodes.map((node) => ({ ...node, position: positions[node.id] ?? node.position }))
        setUndo({ positions: Object.fromEntries(graph.nodes.map((node) => [node.id, node.position])), signature: layoutSignature({ ...graph, nodes: next }) })
        setNodes((current) => current.map((node) => ({ ...node, position: positions[node.id] ?? node.position })))
        frame.current = requestAnimationFrame(() => { frame.current = requestAnimationFrame(onOrganized) })
      }
      running.postMessage(graph)
    } catch { cancel(); onError() }
  }
  const restore = () => {
    if (!undo || undo.signature !== signature) return
    setNodes((current) => current.map((node) => ({ ...node, position: undo.positions[node.id] ?? node.position })))
    setUndo(null)
    frame.current = requestAnimationFrame(onOrganized)
  }
  return { organize, cancel, restore, organizing: job === signature, canUndo: undo !== null && undo.signature === signature }
}
