import { layoutFlowGraph } from './flow-layout'
import type { LayoutGraph } from './flow-layout'

self.onmessage = (event: MessageEvent<LayoutGraph>) => {
  try { self.postMessage({ positions: layoutFlowGraph(event.data) }) }
  catch { self.postMessage({ error: true }) }
}
