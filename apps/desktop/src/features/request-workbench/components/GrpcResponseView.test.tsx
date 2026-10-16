import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import type { ExecuteGrpcRequestOutput } from '../../../bindings/execute-grpc-request'
import { emptyGrpcStream } from '../grpc-stream'
import type { GrpcStreamState } from '../grpc-stream'
import { ResponsePanel } from './ResponsePanel'

const stream: GrpcStreamState = { ...emptyGrpcStream, events: [
  { type: 'started', kind: 'clientStreaming' },
  { type: 'sent', index: 0, json: '{"greeting":"Ada"}', sizeBytes: 18, truncated: false, elapsedMs: 2 },
  { type: 'headers', metadata: [{ name: 'initial', value: 'start' }], elapsedMs: 3 },
] }
const result: ExecuteGrpcRequestOutput = { status: { code: 0, codeName: 'OK', message: '' }, durationMs: 8, messageCount: 1, sizeBytes: 18,
  body: { kind: 'inline', body: '{"reply":"Hello Ada"}' }, headers: [{ name: 'initial', value: 'start' }], trailers: [{ name: 'final', value: 'done' }],
  testResults: [{ name: 'RPC status', passed: true, message: null }],
}

describe('gRPC response layout', () => {
  it('keeps the transcript and expanded message when the call completes, with separate metadata and trailers', () => {
    const props = { onClear: () => {}, layout: 'right' as const, onToggleLayout: () => {} }
    const { rerender } = render(<ResponsePanel {...props} execution={{ status: 'loading', startedAt: 100 }} grpcStream={stream} />)
    expect(screen.getByRole('tab', { name: 'Mensagens', selected: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Enviada #1/ }))
    expect(screen.getByRole('region', { name: 'Enviada #1' })).toBeInTheDocument()
    const completed: GrpcStreamState = { ...stream, events: [...stream.events,
      { type: 'received', index: 0, json: '{"reply":"Hello Ada"}', sizeBytes: 18, truncated: false, elapsedMs: 7 },
      { type: 'finished', status: result.status, trailers: result.trailers, elapsedMs: 8 },
    ] }
    rerender(<ResponsePanel {...props} execution={{ status: 'success', result }} grpcStream={completed} />)
    expect(screen.getByRole('region', { name: 'Enviada #1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Recebida #1/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Metadata' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('initial')
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('final')
    fireEvent.click(screen.getByRole('tab', { name: 'Metadata final' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('final')
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('initial')
    fireEvent.click(screen.getByRole('tab', { name: 'Tests' }))
    expect(within(screen.getByRole('tabpanel')).getByText('RPC status')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Corpo completo' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Hello Ada')
  })

  it('retains received events and shows cancellation instead of a connecting placeholder', () => {
    render(<ResponsePanel execution={{ status: 'error', error: { kind: 'cancelled' } }} grpcStream={stream}
      onClear={() => {}} layout="right" onToggleLayout={() => {}} />)
    expect(screen.getByText('Execução cancelada.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Enviada #1/ })).toBeInTheDocument()
    expect(screen.queryByText('Conectando…')).not.toBeInTheDocument()
  })
})
