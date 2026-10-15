import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import { emptyGrpcStream } from '../grpc-stream'
import { GrpcTimeline } from './GrpcTimeline'
import { GrpcMessagePanel } from './GrpcMessagePanel'

describe('gRPC live interface', () => {
  it('virtualizes message rows and shows bounded JSON on selection', () => {
    render(<GrpcTimeline stream={{ ...emptyGrpcStream, events: Array.from({ length: 500 }, (_, index) => ({
      type: 'received', index, json: `{"index":${index}}`, truncated: true, sizeBytes: 100, elapsedMs: index,
    })) }} />)
    expect(screen.getAllByRole('listitem').length).toBeLessThanOrEqual(10)
    fireEvent.click(screen.getByRole('button', { name: /Recebida #500/ }))
    expect(screen.getByText('{"index":499}')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Prévia da mensagem reduzida')
  })

  it('shows additional-send controls and disables them while an action is pending', () => {
    const send = vi.fn()
    const close = vi.fn()
    const props = { service: '', method: '', message: '{}', onMessageChange: vi.fn(),
      schema: { status: 'idle' as const }, environmentVariables: [], onSendMessage: send, onCloseSend: close }
    const { rerender } = render(<GrpcMessagePanel {...props} stream={{ ...emptyGrpcStream, accepting: true }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }))
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar envio' }))
    expect(send).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    rerender(<GrpcMessagePanel {...props} stream={{ ...emptyGrpcStream, accepting: true, busy: true }} />)
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Encerrar envio' })).toBeDisabled()
    rerender(<GrpcMessagePanel {...props} stream={emptyGrpcStream} />)
    expect(screen.queryByRole('button', { name: 'Enviar mensagem' })).not.toBeInTheDocument()
  })
})
