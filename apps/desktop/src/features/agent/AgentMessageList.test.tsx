import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
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

  it('collapses a chain of tool calls into one group that expands to list them', () => {
    const tool = (id: string, state: Extract<AgentChatItem, { kind: 'tool' }>['state'], canRevert = false): AgentChatItem =>
      ({ kind: 'tool', id, name: 'search_collections', toolClass: 'read', summary: id, state, canRevert, autoApproved: false })
    const { rerender } = render(<AgentMessageList items={[tool('t1', 'done'), tool('t2', 'failed'), tool('t3', 'done', true)]} {...actions} />)
    const toggle = screen.getByRole('button', { name: /3 ações executadas · 1 com falha/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('t1')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reverter' })).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('t1')).toBeInTheDocument()
    expect(screen.getByText('falhou')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reverter' }))
    expect(actions.onRevert).toHaveBeenCalledWith('t3')

    rerender(<AgentMessageList items={[tool('t1', 'done'), tool('t2', 'running'), tool('t3', 'awaitingApproval'), tool('t4', 'done')]} running {...actions} />)
    expect(screen.getByRole('button', { name: /Executando ações \(2\)/ })).toHaveTextContent('Buscou nas collections')
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeInTheDocument()
    expect(screen.getByText('t4')).toBeInTheDocument()
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

  it('copies user messages and finished replies as written', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { rerender } = render(<AgentMessageList items={[
      { kind: 'user', id: 'u', text: 'Liste os usuários', context: [] },
      { kind: 'assistant', id: 'a', streaming: true, text: 'Encontrei **2**' },
    ]} {...actions} />)
    expect(screen.getAllByRole('button', { name: 'Copiar mensagem' })).toHaveLength(1)

    rerender(<AgentMessageList items={[
      { kind: 'user', id: 'u', text: 'Liste os usuários', context: [] },
      { kind: 'assistant', id: 'a', streaming: false, text: 'Encontrei **2**' },
    ]} {...actions} />)
    const [user, reply] = screen.getAllByRole('button', { name: 'Copiar mensagem' })
    reply.focus()
    fireEvent.pointerUp(reply)
    fireEvent.click(reply)
    // A mouse click lets go of the focus, so no ring lingers; the keyboard keeps it.
    expect(reply).not.toHaveFocus()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Encontrei **2**'))
    expect(await screen.findByRole('button', { name: 'Copiado' })).toBeInTheDocument()
    user.focus()
    fireEvent.click(user)
    expect(user).toHaveFocus()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Liste os usuários'))
  })

  it('offers selected chat text as context with the right button', () => {
    const onQuote = vi.fn()
    render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: 'O campo results.sunset traz o horario do por do sol em UTC.' }]} {...actions} onQuote={onQuote} />)
    const paragraph = screen.getByText(/results\.sunset/)
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(screen.getByRole('log'), { clientX: 20, clientY: 30 })
    const menu = screen.getByRole('menu', { name: 'Ações do texto selecionado' })
    // The menu takes the focus, and the selection stays on screen.
    expect(within(menu).getByRole('menuitem', { name: 'Usar como contexto' })).toHaveFocus()
    expect(window.getSelection()?.toString()).toContain('results.sunset')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Usar como contexto' }))
    expect(onQuote).toHaveBeenCalledWith('O campo results.sunset traz o horario do por do sol em UTC.', 'Trecho: “O campo results.sunset traz o ho…”')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    // Without a selection the usual menu stays.
    window.getSelection()?.removeAllRanges()
    fireEvent.contextMenu(screen.getByRole('log'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('reports clipboard failure without losing the code', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) } })
    render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: '```\nGET /users\n```' }]} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copiar código' }))
    expect(await screen.findByText('Não foi possível copiar')).toBeInTheDocument()
    expect(screen.getByText('GET /users')).toBeInTheDocument()
  })

  it('renders reply tables and colors code by its language', () => {
    const { container } = render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: '| Campo | Tipo |\n|---|---|\n| id | int |\n\n```json\n{"ok": true}\n```' }]} {...actions} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Campo' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'int' })).toBeInTheDocument()
    expect(screen.getByText('json')).toBeInTheDocument()
    expect(container.querySelector('.agent-code-token--key')).toHaveTextContent('"ok"')
    expect(container.querySelector('.agent-code-token--keyword')).toHaveTextContent('true')
  })

  it('opens the requests, flows and mocks a reply links to, and marks the ones that are gone', async () => {
    const onOpenReference = vi.fn(async (kind: string) => kind !== 'mock')
    render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: 'Veja [Listar usuários](alcy://request/r1), [Checkout](alcy://flow/f1), [Pagamentos](alcy://mock/m1) e [Outro](alcy://monitor/x).' }]} {...actions} onOpenReference={onOpenReference} />)
    fireEvent.click(screen.getByRole('button', { name: 'Listar usuários' }))
    await waitFor(() => expect(onOpenReference).toHaveBeenCalledWith('request', 'r1'))
    expect(screen.getByRole('button', { name: 'Checkout' })).toHaveAttribute('title', 'Abrir flow')
    const mock = screen.getByRole('button', { name: 'Pagamentos' })
    fireEvent.click(mock)
    await waitFor(() => expect(mock).toHaveAttribute('data-state', 'missing'))
    expect(mock).toHaveAttribute('title', 'Não encontrado no workspace')
    expect(screen.queryByRole('button', { name: 'Outro' })).not.toBeInTheDocument()
    expect(screen.getByText('Outro').tagName).toBe('STRONG')
  })

  it('turns bolded names and code-formatted ids of known items into references', () => {
    const onOpenReference = vi.fn(async () => true)
    const resolveReference = (text: string) => (text === 'Get Users' || text === 'r1' ? { kind: 'request' as const, id: 'r1' } : null)
    render(<AgentMessageList items={[{ kind: 'assistant', id: 'a', streaming: false, text: 'Escolhi **Get Users** (`r1`), **Método:** GET, `{{rota}}`.' }]} {...actions} onOpenReference={onOpenReference} resolveReference={resolveReference} />)
    fireEvent.click(screen.getByRole('button', { name: 'Get Users' }))
    expect(onOpenReference).toHaveBeenCalledWith('request', 'r1')
    expect(screen.getByRole('button', { name: 'r1' })).toBeInTheDocument()
    expect(screen.getByText('Método:').tagName).toBe('STRONG')
    expect(screen.getByText('{{rota}}').tagName).toBe('CODE')
  })

  it('shows fenced and pasted JSON in user messages as copyable code blocks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<AgentMessageList items={[
      { kind: 'user', id: 'u1', text: 'Valide:\n```json\n{"a": 1}\n```', context: [] },
      { kind: 'user', id: 'u2', text: '[1, 2]', context: [] },
    ]} {...actions} />)
    expect(screen.getByText('Valide:')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Copiar código' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('[1, 2]'))
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
