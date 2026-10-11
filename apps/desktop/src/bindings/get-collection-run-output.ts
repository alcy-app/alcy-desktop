import { invoke } from '@tauri-apps/api/core'
import type { FlowNodeOutputDto } from './get-flow-node-output'

/** Resposta guardada de uma requisição do último run, buscada sob demanda.
 * `null` quando não existe (run antigo ou resposta não guardada). */
export function getCollectionRunOutput(
  runId: string,
  iteration: number,
  position: number,
): Promise<FlowNodeOutputDto | null> {
  return invoke<FlowNodeOutputDto | null>('get_collection_run_output', { input: { runId, iteration, position } })
}
