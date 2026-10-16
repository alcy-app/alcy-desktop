import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import { emptyGrpcStream } from '../grpc-stream'
import { GrpcTimeline } from './GrpcTimeline'
import { GrpcMessagePanel } from './GrpcMessagePanel'

describe('gRPC live interface', () => {
  it('virtualizes message rows and shows bounded JSON on selection', () => {
    render(<GrpcTimeline stream={{ ...emptyGrpcStream, events: Array.from({ length: 500 }, (_, index) => ({
      type: 'received', index, json: `{"index":${index}}`, truncated: true, sizeBytes: 100, elapsedMs: index,
    })) }} />)
    expect(screen.getAllByRole('listitem').length).toBeLessThan(30)
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

  it('shows newest events first, filters by direction and searches message contents', () => {
    render(<GrpcTimeline stream={{ ...emptyGrpcStream, startedAt: 100000, events: [
      { type: 'sent', index: 0, json: '{"greeting":"Ada"}', truncated: false, sizeBytes: 18, elapsedMs: 10 },
      { type: 'received', index: 0, json: '{"reply":"Hello Ada"}', truncated: false, sizeBytes: 21, elapsedMs: 20 },
    ] }} />)
    expect(within(screen.getAllByRole('listitem')[0]).getByRole('button')).toHaveAccessibleName(/Recebida #1/)
    fireEvent.change(screen.getByRole('combobox', { name: 'Direção das mensagens' }), { target: { value: 'sent' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Enviada #1/ })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: /Enviada #1/ }))
    expect(screen.getByRole('region', { name: 'Enviada #1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Enviada #1/ }))
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar mensagens' }), { target: { value: 'missing' } })
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Nenhum evento encontrado.')
  })

  it('keeps client streaming controls disabled before starting and after half-close', () => {
    const props = { service: 'test.Greeter', method: 'Hello', message: '{}', onMessageChange: vi.fn(),
      schema: { status: 'success' as const, schema: { services: [{ name: 'test.Greeter', methods: [{ name: 'Hello', kind: 'clientStreaming' as const,
        inputType: 'HelloRequest', outputType: 'HelloReply', inputTemplate: '{}', inputSchema: {} }] }] } },
      environmentVariables: [], onSendMessage: vi.fn(), onCloseSend: vi.fn() }
    const { rerender } = render(<GrpcMessagePanel {...props} stream={emptyGrpcStream} />)
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Encerrar envio' })).toBeDisabled()
    const footer = screen.getByRole('group', { name: 'Controles da mensagem gRPC' })
    expect(within(footer).getAllByRole('button').map((button) => button.textContent)).toEqual(['Gerar exemplo', 'Encerrar envio', 'Enviar mensagem'])
    rerender(<GrpcMessagePanel {...props} stream={{ ...emptyGrpcStream, accepting: true }} isSending />)
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled()
    rerender(<GrpcMessagePanel {...props} stream={emptyGrpcStream} isSending />)
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Aguardando o servidor')
  })
})
