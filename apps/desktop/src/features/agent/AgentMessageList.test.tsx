import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { AgentMessageList } from './AgentMessageList'

const actions = { onApprove: vi.fn(), onDecline: vi.fn(), onRevert: vi.fn() }

afterEach(() => vi.unstubAllGlobals())

describe('AgentMessageList', () => {
  it('copies individual code blocks, including blocks nested in Markdown lists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: 'Example:\n\n```json\n{"ok":true}\n```\n\n- Nested:\n\n  ```sh\n  echo ok\n  ```' }]} {...actions} />)
    const buttons = screen.getAllByRole('button', { name: 'Copiar código' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"ok":true}'))
    expect(await screen.findByText('Copiado')).toBeInTheDocument()
    fireEvent.click(buttons[1])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('echo ok'))
  })

  it('reports clipboard failure without losing the code', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) } })
    render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: '```\nGET /users\n```' }]} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copiar código' }))
    expect(await screen.findByText('Não foi possível copiar')).toBeInTheDocument()
    expect(screen.getByText('GET /users')).toBeInTheDocument()
  })

  it('shows a streaming status only while the assistant is responding', () => {
    const { rerender } = render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: true, text: 'Olá' }]} {...actions} />)
    expect(screen.getByRole('status', { name: 'O agente está respondendo' })).toBeInTheDocument()
    rerender(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: 'Olá' }]} {...actions} />)
    expect(screen.queryByRole('status', { name: 'O agente está respondendo' })).not.toBeInTheDocument()
  })
})
