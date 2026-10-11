import { invoke } from '@tauri-apps/api/core'

export interface FlowNodeOutputDto {
  statusCode: number
  durationMs: number
  sizeBytes: number
  headers: { name: string; value: string }[]
  /** Só o começo do corpo (limite no backend); vazio quando binário. */
  body: string
  bodyEncoding: 'text' | 'base64'
  truncated: boolean
  /** Presente quando a saída é a chamada recebida por um bloco "Aguardar
   * chamada" (spec 0121): `headers`/`body` são os da chamada. */
  request?: { method: string; path: string }
}

/** Saída de um node de requisição do último run, buscada sob demanda (o evento
 * de progresso não a carrega). `null` quando não existe. */
export function getFlowNodeOutput(flowExecutionId: string, nodeId: string): Promise<FlowNodeOutputDto | null> {
  return invoke<FlowNodeOutputDto | null>('get_flow_node_output', { input: { flowExecutionId, nodeId } })
}
