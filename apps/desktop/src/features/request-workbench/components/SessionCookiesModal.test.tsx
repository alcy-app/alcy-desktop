import { describe, expect, it, vi } from 'vitest'
import type { SessionCookieDto } from '../../../bindings/session-cookies'
import { fireEvent, render, screen } from '../../../test-utils'
import { SessionCookiesModal } from './SessionCookiesModal'

const sid: SessionCookieDto = {
  name: 'sid',
  value: 'abc',
  domain: 'api.test',
  hostOnly: true,
  path: '/',
  secure: false,
  expiresAtMs: null,
}

describe('SessionCookiesModal', () => {
  it('lista os cookies e remove um ou todos', () => {
    const onDelete = vi.fn()
    const onClearAll = vi.fn()
    render(<SessionCookiesModal cookies={[sid]} onDelete={onDelete} onClearAll={onClearAll} onClose={() => {}} />)

    expect(screen.getByText('abc')).toBeInTheDocument()
    expect(screen.getByText('Fim da sessão')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remover cookie sid' }))
    expect(onDelete).toHaveBeenCalledWith(sid)

    fireEvent.click(screen.getByRole('button', { name: 'Limpar todos' }))
    expect(onClearAll).toHaveBeenCalled()
  })

  it('mostra o estado vazio e desabilita "Limpar todos"', () => {
    render(<SessionCookiesModal cookies={[]} onDelete={() => {}} onClearAll={() => {}} onClose={() => {}} />)

    expect(screen.getByText('Nenhum cookie guardado.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Limpar todos' })).toBeDisabled()
  })
})
