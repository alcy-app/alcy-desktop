import type { HttpMethodInput } from '../../../bindings/execute-rest-request'
import { Badge } from '../../../shared/ui/Badge'
import type { RequestProtocol } from '../collection-tree'

const METHOD_BADGE_TONE: Record<HttpMethodInput, 'success' | 'accent' | 'warning' | 'error' | 'neutral'> = {
  get: 'success',
  post: 'accent',
  put: 'warning',
  patch: 'warning',
  delete: 'error',
  head: 'neutral',
  options: 'neutral',
}

interface RequestMethodBadgeProps {
  protocol: RequestProtocol
  method: HttpMethodInput
  className?: string
  /** Esconde o badge de leitores de tela quando o nome ao lado já identifica o item (ex.: abas). */
  'aria-hidden'?: boolean
}

/** Marks a request example in the collection tree and in open tabs. */
export function ExampleBadge({ className, 'aria-hidden': ariaHidden }: Pick<RequestMethodBadgeProps, 'className' | 'aria-hidden'>) {
  return (
    <Badge tone="neutral" className={className} aria-hidden={ariaHidden}>
      e.g.
    </Badge>
  )
}

/** Badge do método HTTP (REST) ou "GQL" (GraphQL) — usado na árvore de collections e nas abas abertas. */
export function RequestMethodBadge({ protocol, method, className, 'aria-hidden': ariaHidden }: RequestMethodBadgeProps) {
  if (protocol === 'rest') {
    return (
      <Badge tone={METHOD_BADGE_TONE[method]} className={className} aria-hidden={ariaHidden}>
        {method.toUpperCase()}
      </Badge>
    )
  }

  if (protocol === 'grpc' || protocol === 'websocket') {
    return (
      <Badge tone="info" className={className} aria-hidden={ariaHidden}>
        {protocol === 'grpc' ? 'gRPC' : 'WS'}
      </Badge>
    )
  }

  return (
    <Badge tone="accent" className={className} aria-hidden={ariaHidden}>
      GQL
    </Badge>
  )
}
