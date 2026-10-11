import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '../../test-utils'
import { openExternalUrl } from '../../bindings/open-external-url'
import { NotificationsButton } from './NotificationsButton'
import type { AppNotification } from './notifications.types'

vi.mock('../../bindings/open-external-url', () => ({ openExternalUrl: vi.fn() }))

const notifications: AppNotification[] = [
  {
    id: 'antigo',
    kind: 'update',
    date: '2026-01-10',
    title: { 'pt-BR': 'Versão 1.0', en: 'Version 1.0' },
    message: { 'pt-BR': 'Nova versão disponível.', en: 'New version available.' },
  },
  {
    id: 'novo',
    kind: 'alert',
    date: '2026-09-20',
    title: { 'pt-BR': 'Manutenção', en: 'Maintenance' },
    message: { 'pt-BR': 'Instabilidade prevista.', en: 'Expected instability.' },
  },
]

describe('NotificationsButton', () => {
  afterEach(() => vi.restoreAllMocks())

  it('mostra o total de não lidas e zera ao abrir, persistindo o estado', () => {
    const { unmount } = render(<NotificationsButton notifications={notifications} />)
    const button = screen.getByRole('button', { name: 'Notificações: 2 não lida(s)' })
    expect(button).toHaveTextContent('2')

    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Notificações' })).not.toHaveTextContent('2')
    expect(screen.getAllByRole('img', { name: 'Não lida' })).toHaveLength(2)
    unmount()

    render(<NotificationsButton notifications={notifications} />)
    expect(screen.getByRole('button', { name: 'Notificações' })).toBeInTheDocument()
  })

  it('volta a contar apenas avisos com id novo', () => {
    window.localStorage.setItem('alcy:notifications:read', JSON.stringify(['antigo']))
    render(<NotificationsButton notifications={notifications} />)
    expect(screen.getByRole('button', { name: 'Notificações: 1 não lida(s)' })).toBeInTheDocument()
  })

  it('lista os avisos do mais recente para o mais antigo no idioma ativo', () => {
    render(<NotificationsButton notifications={notifications} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    const dialog = screen.getByRole('dialog', { name: 'Notificações' })
    const items = dialog.querySelectorAll('li')
    expect(items[0]).toHaveTextContent('Manutenção')
    expect(items[0]).toHaveTextContent('Alerta')
    expect(items[1]).toHaveTextContent('Versão 1.0')
    expect(items[1]).toHaveTextContent('Nova versão disponível.')
  })

  it('não oferece expansão quando a mensagem cabe no card', () => {
    render(<NotificationsButton notifications={notifications} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    const dialog = screen.getByRole('dialog')
    expect(screen.queryByRole('button', { name: /^Mostrar ou ocultar/ })).not.toBeInTheDocument()
    expect(dialog.querySelector('.notifications-card-chevron')).toBeNull()
  })

  it('preserva as quebras de linha da mensagem', () => {
    const multiline: AppNotification = { ...notifications[0], message: { 'pt-BR': 'Linha 1\nLinha 2', en: 'Line 1\nLine 2' } }
    render(<NotificationsButton notifications={[multiline]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    expect(screen.getByRole('dialog').querySelector('.notifications-card-message')?.textContent).toBe('Linha 1\nLinha 2')
  })

  it('expande e recolhe o card ao clicar, um por vez', () => {
    // jsdom não faz layout: simula mensagens maiores que as duas linhas visíveis.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(80)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(40)
    render(<NotificationsButton notifications={notifications} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    const alert = screen.getByRole('button', { name: /^Mostrar ou ocultar.*Manutenção/ })
    const update = screen.getByRole('button', { name: /^Mostrar ou ocultar.*Versão 1.0/ })
    expect(alert).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(alert)
    expect(alert).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(update)
    expect(alert).toHaveAttribute('aria-expanded', 'false')
    expect(update).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(update)
    expect(update).toHaveAttribute('aria-expanded', 'false')
  })

  it('abre links da mensagem no navegador do sistema sem expandir o card', () => {
    vi.mocked(openExternalUrl).mockResolvedValueOnce({ ok: true })
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(80)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(40)
    const withLink: AppNotification = {
      ...notifications[0],
      message: { 'pt-BR': 'Veja [as novidades](https://alcy.dev/v1).', en: 'See [what is new](https://alcy.dev/v1).' },
    }
    render(<NotificationsButton notifications={[withLink]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    const toggle = screen.getByRole('button', { name: /^Mostrar ou ocultar.*Versão 1.0/ })
    fireEvent.click(toggle)
    const link = screen.getByRole('link', { name: 'as novidades' })
    expect(link).toHaveAttribute('href', 'https://alcy.dev/v1')

    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://alcy.dev/v1')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('avisa quando o link não pode ser aberto', async () => {
    vi.mocked(openExternalUrl).mockResolvedValueOnce({ ok: false, error: { kind: 'failed', message: 'x' } })
    const withLink: AppNotification = {
      ...notifications[0],
      message: { 'pt-BR': '[Guia](https://alcy.dev/guia)', en: '[Guide](https://alcy.dev/guia)' },
    }
    render(<NotificationsButton notifications={[withLink]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))
    fireEvent.click(screen.getByRole('link', { name: 'Guia' }))

    await waitFor(() => expect(screen.getByText('Não foi possível abrir o link no navegador.')).toBeInTheDocument())
  })

  it('abre os detalhes de uma atualização ao clicar no card e fecha o popup', () => {
    const onOpenDetails = vi.fn()
    const withDetails: AppNotification = { ...notifications[0], details: { 'pt-BR': '## Novidades', en: '## What is new' } }
    render(<NotificationsButton notifications={[withDetails, notifications[1]]} onOpenDetails={onOpenDetails} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    fireEvent.click(screen.getByText('Versão 1.0'))

    expect(onOpenDetails).toHaveBeenCalledWith(withDetails)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('oferece um botão de detalhes acessível pelo teclado', () => {
    const onOpenDetails = vi.fn()
    const withDetails: AppNotification = { ...notifications[0], details: { 'pt-BR': '## Novidades', en: '## What is new' } }
    render(<NotificationsButton notifications={[withDetails]} onOpenDetails={onOpenDetails} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes: Versão 1.0' }))
    expect(onOpenDetails).toHaveBeenCalledTimes(1)
  })

  it('só atualizações com detalhes abrem a aba', () => {
    const onOpenDetails = vi.fn()
    const alertWithDetails: AppNotification = { ...notifications[1], details: { 'pt-BR': 'x', en: 'x' } }
    const updateWithBlankDetails: AppNotification = { ...notifications[0], details: { 'pt-BR': '  ', en: '  ' } }
    render(<NotificationsButton notifications={[alertWithDetails, updateWithBlankDetails]} onOpenDetails={onOpenDetails} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    fireEvent.click(screen.getByText('Manutenção'))
    fireEvent.click(screen.getByText('Versão 1.0'))

    expect(onOpenDetails).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Ver detalhes/ })).not.toBeInTheDocument()
  })

  it('dispensa o aviso com animação de saída, sem fechar o popup, e não o mostra mais', () => {
    vi.useFakeTimers()
    const onOpenDetails = vi.fn()
    const withDetails: AppNotification = { ...notifications[0], details: { 'pt-BR': '## Novidades', en: '## What is new' } }
    const { unmount } = render(<NotificationsButton notifications={[withDetails, notifications[1]]} onOpenDetails={onOpenDetails} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Dispensar notificação: Versão 1.0' }))
    expect(onOpenDetails).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    const leaving = dialog.querySelector('li[data-leaving="true"]')
    expect(leaving).toHaveTextContent('Versão 1.0')
    expect(dialog).toHaveFocus()

    act(() => vi.advanceTimersByTime(300))
    expect(dialog.querySelectorAll('li')).toHaveLength(1)
    expect(dialog).toHaveTextContent('Manutenção')
    vi.useRealTimers()
    unmount()

    render(<NotificationsButton notifications={[withDetails, notifications[1]]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notificações/ }))
    expect(screen.queryByText('Versão 1.0')).not.toBeInTheDocument()
  })

  it('não conta avisos dispensados como não lidos', () => {
    window.localStorage.setItem('alcy:notifications:dismissed', JSON.stringify(['novo']))
    render(<NotificationsButton notifications={notifications} />)
    expect(screen.getByRole('button', { name: 'Notificações: 1 não lida(s)' })).toBeInTheDocument()
  })

  it('mostra o estado vazio', () => {
    render(<NotificationsButton notifications={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notificações' }))
    expect(screen.getByText('Nenhuma notificação por enquanto.')).toBeInTheDocument()
  })

  it('fecha com Escape e devolve o foco ao sino', () => {
    render(<NotificationsButton notifications={notifications} />)
    const button = screen.getByRole('button', { name: /^Notificações/ })
    fireEvent.click(button)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })
})
