import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import { AgentMessageList } from './AgentMessageList'
import type { AgentChatItem } from './use-agent-session'

const actions = { onApprove: vi.fn(), onDecline: vi.fn(), onRevert: vi.fn() }

afterEach(() => vi.unstubAllGlobals())

describe('AgentMessageList', () => {
  it('shows thinking between model responses, without duplicating streaming or tool progress', () => {
    const user: AgentChatItem = { kind: 'user', id: 'u', text: 'Crie um flow', context: [] }
    const tool: Extract<AgentChatItem, { kind: 'tool' }> = { kind: 'tool', id: 'tool', name: 'create_flow', toolClass: 'sideEffect', summary: 'Example', state: 'running', canRevert: false, autoApproved: false }
    const { rerender } = render(<AgentMessageList items={[tool, user]} running {...actions} />)
    expect(screen.getByRole('status', { name: 'O Alcy está pensando' })).toBeInTheDocument()

    rerender(<AgentMessageList items={[user, { kind: 'assistant', id: 'a', text: 'Vou criar o flow.', streaming: true }]} running {...actions} />)
    expect(screen.queryByRole('status', { name: 'O Alcy está pensando' })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'O agente está respondendo' })).toBeInTheDocument()

    rerender(<AgentMessageList items={[user, tool]} running {...actions} />)
    expect(screen.queryByRole('status', { name: 'O Alcy está pensando' })).not.toBeInTheDocument()
    rerender(<AgentMessageList items={[user, { ...tool, state: 'awaitingApproval' }]} running {...actions} />)
    expect(screen.queryByRole('status', { name: 'O Alcy está pensando' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeInTheDocument()

    rerender(<AgentMessageList items={[user, { ...tool, state: 'done' }]} running {...actions} />)
    expect(screen.getByRole('status', { name: 'O Alcy está pensando' })).toBeInTheDocument()
    rerender(<AgentMessageList items={[user, { ...tool, state: 'done' }]} running={false} {...actions} />)
    expect(screen.queryByRole('status', { name: 'O Alcy está pensando' })).not.toBeInTheDocument()
  })

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

  it('shows the time of each message and a line when the day changes', () => {
    const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).getTime()
    render(
      <AgentMessageList
        items={[
          { kind: 'user', id: 'old', text: 'sem horário', context: [] },
          { kind: 'user', id: 'u1', text: 'ola', context: [], atMs: at(28, 21, 4) },
          { kind: 'assistant', id: 'a1', text: 'Olá!', streaming: false, atMs: at(28, 21, 5) },
          { kind: 'user', id: 'u2', text: 'ok', context: [], atMs: at(29, 9, 4) },
        ]}
        {...actions}
      />,
    )
    expect(screen.getAllByRole('separator')).toHaveLength(2)
    expect(screen.getByText('21:04')).toBeInTheDocument()
    expect(screen.getByText('21:05')).toBeInTheDocument()
    expect(screen.getByText(/^0?9:04$/)).toBeInTheDocument()
    expect(document.querySelectorAll('time')).toHaveLength(3)
  })

  it('shows a streaming status only while the assistant is responding', () => {
    const { rerender } = render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: true, text: 'Olá' }]} {...actions} />)
    expect(screen.getByRole('status', { name: 'O agente está respondendo' })).toBeInTheDocument()
    rerender(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: 'Olá' }]} {...actions} />)
    expect(screen.queryByRole('status', { name: 'O agente está respondendo' })).not.toBeInTheDocument()
  })
})
