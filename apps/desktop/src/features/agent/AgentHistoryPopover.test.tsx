import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../test-utils'
import { AgentHistoryPopover } from './AgentHistoryPopover'

const listAgentSessions = vi.fn()
vi.mock('../../bindings/agent-sessions', () => ({
  listAgentSessions: (...args: unknown[]) => listAgentSessions(...args),
  deleteAgentSession: vi.fn(async () => ({ ok: true })),
}))

beforeEach(() => listAgentSessions.mockReset())

describe('AgentHistoryPopover', () => {
  it('groups chats by local calendar date and keeps the active chat highlighted', async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const older = new Date(today)
    older.setDate(older.getDate() - 4)
    listAgentSessions.mockResolvedValue({ ok: true, value: [
      { id: 'old', title: 'Old chat', updatedAtMs: older.getTime() },
      { id: 'now', title: 'Current chat', updatedAtMs: today.getTime() },
      { id: 'yesterday', title: 'Previous chat', updatedAtMs: yesterday.getTime() },
    ] })
    const onOpen = vi.fn()
    const onClose = vi.fn()
    render(<AgentHistoryPopover rootPath="/w" activeSessionId="now" onOpen={onOpen} onDeleted={() => {}} onClose={onClose} />)
    expect(await screen.findByRole('region', { name: 'Hoje' })).toHaveTextContent('Current chat')
    expect(screen.getByRole('region', { name: 'Ontem' })).toHaveTextContent('Previous chat')
    expect(screen.getByRole('region', { name: 'Anteriores' })).toHaveTextContent('Old chat')
    const current = screen.getByRole('button', { name: /^Current chat/ }).closest('li')!
    expect(current).toHaveAttribute('aria-current', 'true')
    expect(within(current).getByRole('button', { name: /Excluir/ })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Buscar chats' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: /^Previous chat/ }))
    expect(onOpen).toHaveBeenCalledWith('yesterday')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows an empty search result and allows returning to the list', async () => {
    listAgentSessions.mockResolvedValue({ ok: true, value: [{ id: 'one', title: 'Users', updatedAtMs: Date.now() }] })
    render(<AgentHistoryPopover rootPath="/w" activeSessionId={null} onOpen={() => {}} onDeleted={() => {}} onClose={() => {}} />)
    await screen.findByText('Users')
    const search = screen.getByRole('textbox', { name: 'Buscar chats' })
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText('Nenhum chat encontrado')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'users' } })
    expect(screen.getByText('Users')).toBeInTheDocument()
  })
})
