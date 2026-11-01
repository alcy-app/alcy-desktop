import { layoutFlowGraph, type FlowPositions, type LayoutGraph } from './flow-layout'

/** Lay out a graph off the UI thread; without workers (tests) it runs inline. */
export function runFlowLayout(graph: LayoutGraph): Promise<FlowPositions> {
  if (typeof Worker === 'undefined') return Promise.resolve(layoutFlowGraph(graph))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./flow-layout.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => worker.terminate()
    worker.onerror = () => { finish(); reject(new Error('The flow layout failed.')) }
    worker.onmessage = (event: MessageEvent<{ positions?: FlowPositions; error?: boolean }>) => {
      finish()
      if (event.data.positions) resolve(event.data.positions)
      else reject(new Error('The flow layout failed.'))
    }
    worker.postMessage(graph)
  })
}
