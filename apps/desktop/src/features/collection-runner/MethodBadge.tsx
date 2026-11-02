import { Badge } from '../../shared/ui/Badge'

type Tone = 'success' | 'accent' | 'warning' | 'error' | 'neutral'

const METHOD_TONE: Record<string, Tone> = {
  get: 'success',
  post: 'accent',
  put: 'warning',
  patch: 'warning',
  delete: 'error',
}

/** Método REST (com a cor da sidebar) ou `GQL` para GraphQL. */
export function MethodBadge({ protocol, method }: { protocol: string | null; method: string }) {
  if (protocol === 'graphql') {
    return (
      <Badge tone="accent" className="runner-method">
        GQL
      </Badge>
    )
  }
  if (protocol === 'grpc' || protocol === 'websocket') {
    return (
      <Badge tone="info" className="runner-method">
        {protocol === 'grpc' ? 'gRPC' : 'WS'}
      </Badge>
    )
  }
  return (
    <Badge tone={METHOD_TONE[method] ?? 'neutral'} className="runner-method">
      {method ? method.toUpperCase() : '—'}
    </Badge>
  )
}
