import type { RequestSendDto } from '../../bindings/list-request-sends'

/** `false` quando o envio guardou só status, tempo e tamanho — sem a resposta. */
export function sendHasStoredResponse(send: RequestSendDto): boolean {
  return send.outcome.type !== 'success' || send.outcome.responseStored
}

/** Ordena o par para o diff: o envio mais antigo é o lado "−" e o mais novo, o "+". */
export function orderPair(first: RequestSendDto, second: RequestSendDto): { base: RequestSendDto; target: RequestSendDto } {
  return first.executedAtMs <= second.executedAtMs ? { base: first, target: second } : { base: second, target: first }
}
