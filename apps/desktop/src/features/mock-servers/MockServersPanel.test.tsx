import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { listMockServers } from '../../bindings/mock-servers'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { MockServersPanel } from './MockServersPanel'

vi.mock('../../bindings/mock-servers', () => ({ listMockServers: vi.fn(), saveMockServer: vi.fn() }))

beforeEach(() => {
  vi.mocked(listMockServers).mockResolvedValue({ ok: true, value: { servers: [
    { id: 'users', name: 'Usuários', port: 3001, running: false, routesCount: 1 },
    { id: 'orders', name: 'Pedidos', port: 3002, running: true, routesCount: 2 },
  ] } })
})

describe('MockServersPanel', () => {
  it('marca na lista o servidor aberto na aba ativa', async () => {
    const onOpenServer = vi.fn()
    const view = render(<MockServersPanel rootPath="/workspace" activeServerId="orders" onOpenServer={onOpenServer} />)
    const orders = (await screen.findByText('Pedidos')).closest('button')
    const users = screen.getByText('Usuários').closest('button')
    expect(orders).toHaveAttribute('aria-current', 'page')
    expect(users).not.toHaveAttribute('aria-current')

    fireEvent.click(users!)
    expect(onOpenServer).toHaveBeenCalledWith('users', 'Usuários')
    view.rerender(<MockServersPanel rootPath="/workspace" activeServerId="users" onOpenServer={onOpenServer} />)
    expect(users).toHaveAttribute('aria-current', 'page')
    expect(orders).not.toHaveAttribute('aria-current')
  })

  it('segue o idioma escolhido', async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    try {
      render(<MockServersPanel rootPath="/workspace" activeServerId={null} onOpenServer={vi.fn()} />)
      expect(await screen.findByText('localhost:3002 · 2 routes')).toBeInTheDocument()
      expect(screen.getByText('localhost:3001 · 1 route')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'New mock server' })).toBeInTheDocument()
    } finally {
      window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    }
  })
})
