import type { FlowRunEventDto } from '../../bindings/execute-flow'
import type { FlowEdgeState, FlowSourceHandle } from './flows.types'
import type { NodeRunStatus } from './use-flow-run'

/** Saída tomada por um node ao concluir, derivada do evento do run. `null`
 * quando o evento não representa nada percorrido; `undefined` para um node de
 * saída única (edges sem handle). Espelha `request_taken_handle` e as decisões
 * de handle do `If` e do `While` em `crates/alcy-app/src/execute_flow.rs` — manter os dois
 * em sincronia. Cancelamento não acende nenhuma edge (no motor o handle é
 * `failure`, mas todo sucessor vira `Skipped(Cancelled)` — nada é percorrido). */
export function takenHandleForEvent(event: FlowRunEventDto): FlowSourceHandle | undefined | null {
  switch (event.type) {
    case 'nodeSucceeded':
      return event.statusCode >= 400 ? 'failure' : 'success'
    case 'nodeFailed':
      return 'failure'
    case 'nodeBranched':
      return event.result ? 'true' : 'false'
    case 'nodeCompleted':
      return undefined
    case 'nodeLoopIteration':
      return 'loop'
    case 'nodeLoopFinished':
      return 'done'
    case 'nodeSkipped':
      return event.reason === 'notRunnable' ? undefined : null
    default:
      return null
  }
}

/** Edges que o run efetivamente percorreu por causa deste evento: as que saem
 * do node sem handle (saída única — sempre seguem, mesmo com o node falhando)
 * ou pelo handle tomado — mesma comparação de `edge_is_taken` em
 * `advance_after_completion` (`execute_flow.rs`). */
export function traversedEdgeIds(event: FlowRunEventDto, edges: FlowEdgeState[]): string[] {
  if (!('nodeId' in event)) return []
  const handle = takenHandleForEvent(event)
  if (handle === null) return []
  return edges
    .filter((edge) => edge.sourceNodeId === event.nodeId && (edge.sourceHandle === undefined || edge.sourceHandle === handle))
    .map((edge) => edge.id)
}

/** Node por onde o run já passou (rodou, decidiu ou foi atravessado como
 * bloco genérico) — não inclui nodes pulados por ramo não tomado, inalcançáveis
 * ou cancelados. */
export function isVisitedStatus(status: NodeRunStatus | undefined): boolean {
  if (!status) return false
  if (
    status.status === 'success' ||
    status.status === 'failed' ||
    status.status === 'branched' ||
    status.status === 'completed' ||
    status.status === 'looping' ||
    status.status === 'loopFinished'
  ) {
    return true
  }
  return status.status === 'skipped' && status.reason === 'notRunnable'
}
