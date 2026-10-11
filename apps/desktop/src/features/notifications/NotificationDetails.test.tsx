import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { openExternalUrl } from '../../bindings/open-external-url'
import { NotificationDetails } from './NotificationDetails'
import type { AppNotification } from './notifications.types'

vi.mock('../../bindings/open-external-url', () => ({ openExternalUrl: vi.fn() }))

const NOTES = [
  '# Novidades',
  '',
  'Versão com **melhorias** e `pnpm check` mais rápido.',
  '',
  '- Aba de detalhes',
  '- Veja [o MR](https://gitlab.corp/alcy/-/merge_requests/7)',
  '',
  '```',
  '<b>código</b>',
  '```',
  '',
  '<img src=x onerror="alert(1)">',
].join('\n')

const update: AppNotification = {
  id: 'update:2.0.0',
  kind: 'update',
  date: '2026-10-01',
  title: { 'pt-BR': 'Alcy 2.0.0 disponível', en: 'Alcy 2.0.0 available' },
  message: { 'pt-BR': 'Nova versão.', en: 'New version.' },
  details: { 'pt-BR': NOTES, en: NOTES },
}

describe('NotificationDetails', () => {
  it('mostra o título da notificação e o Markdown dos detalhes', () => {
    const { container } = render(<NotificationDetails notification={update} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Alcy 2.0.0 disponível' })).toBeInTheDocument()
    // Títulos do Markdown descem um nível, abaixo do título da página.
    expect(screen.getByRole('heading', { level: 2, name: 'Novidades' })).toBeInTheDocument()
    expect(screen.getByText('melhorias').tagName).toBe('STRONG')
    expect(screen.getByText('pnpm check').tagName).toBe('CODE')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('pre code')?.textContent).toBe('<b>código</b>')
  })

  it('não interpreta HTML das notas', () => {
    const { container } = render(<NotificationDetails notification={update} />)

    expect(container.querySelector('img, b')).toBeNull()
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument()
  })

  it('abre os links no navegador do sistema', () => {
    vi.mocked(openExternalUrl).mockResolvedValueOnce({ ok: true })
    render(<NotificationDetails notification={update} />)

    const link = screen.getByRole('link', { name: 'o MR' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(link, click)

    expect(click.defaultPrevented).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://gitlab.corp/alcy/-/merge_requests/7')
  })
})
