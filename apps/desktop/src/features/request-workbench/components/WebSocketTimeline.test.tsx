import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import { emptyWebSocketStream } from '../websocket-stream'
import { WebSocketMessagePanel } from './WebSocketMessagePanel'
import { WebSocketTimeline } from './WebSocketTimeline'

describe('WebSocket live interface', () => {
  it('virtualizes message rows', () => {
    render(<WebSocketTimeline stream={{ ...emptyWebSocketStream, status: 'open', events: Array.from({ length: 500 }, (_, index) => ({
      type: 'message' as const, direction: 'received' as const, index, format: 'text' as const, data: `message ${index}`, truncated: false, sizeBytes: 10, elapsedMs: index,
    })) }} />)
    expect(screen.getAllByRole('listitem').length).toBeLessThan(30)
  })

  it('shows newest first, filters by direction and expands a message', () => {
    render(<WebSocketTimeline stream={{ ...emptyWebSocketStream, status: 'closed', startedAt: 100000, events: [
      { type: 'opened', status: 101, headers: [{ name: 'upgrade', value: 'websocket' }], subprotocol: 'chat', elapsedMs: 5 },
      { type: 'message', direction: 'sent', index: 0, format: 'text', data: '{"join":"general"}', truncated: false, sizeBytes: 18, elapsedMs: 10 },
      { type: 'message', direction: 'received', index: 0, format: 'binary', data: 'AAE=', truncated: false, sizeBytes: 2, elapsedMs: 20 },
      { type: 'closed', code: 4001, reason: 'bye', closedBy: 'server', elapsedMs: 30 },
    ] }} />)
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByRole('button')).toHaveAccessibleName(/Conexão encerrada/)
    expect(rows[0]).toHaveTextContent('Encerrada pelo servidor · 4001: bye')
    fireEvent.change(screen.getByRole('combobox', { name: 'Direção das mensagens' }), { target: { value: 'sent' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Enviada #1/ }))
    expect(screen.getByRole('region', { name: 'Enviada #1' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar mensagens' }), { target: { value: 'missing' } })
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Nenhuma mensagem')
  })

  it('enables sending only on an open, idle connection', () => {
    const onSend = vi.fn()
    const props = { message: 'hi', format: 'text' as const, onMessageChange: vi.fn(), onFormatChange: vi.fn(), onSend, environmentVariables: [] }
    const { rerender } = render(<WebSocketMessagePanel {...props} isConnected={false} />)
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Desconectado')
    rerender(<WebSocketMessagePanel {...props} isConnected stream={{ ...emptyWebSocketStream, status: 'open' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }))
    expect(onSend).toHaveBeenCalledOnce()
    rerender(<WebSocketMessagePanel {...props} isConnected stream={{ ...emptyWebSocketStream, status: 'open', busy: true }} />)
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled()
  })
})
