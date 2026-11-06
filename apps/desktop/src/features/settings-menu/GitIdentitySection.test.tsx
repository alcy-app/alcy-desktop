import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils'
import type { GitIdentityDto } from '../../bindings/local-git'
import { GitIdentitySection } from './GitIdentitySection'

const getGitIdentity = vi.fn()
const saveGitIdentity = vi.fn()

vi.mock('../../bindings/local-git', () => ({
  getGitIdentity: (...a: unknown[]) => getGitIdentity(...a),
  saveGitIdentity: (...a: unknown[]) => saveGitIdentity(...a),
}))

const fromSystem: GitIdentityDto = {
  system: { name: 'Ana Lima', email: 'ana@example.com' },
  overrides: { name: null, email: null },
  effective: { name: 'Ana Lima', email: 'ana@example.com' },
}

beforeEach(() => {
  getGitIdentity.mockReset()
  saveGitIdentity.mockReset()
})

describe('GitIdentitySection', () => {
  it('shows the system git user as the default author', async () => {
    getGitIdentity.mockResolvedValue({ ok: true, value: fromSystem })
    render(<GitIdentitySection />)

    expect(await screen.findByText('Os commits serão assinados por Ana Lima <ana@example.com>.')).toBeInTheDocument()
    expect(screen.getByLabelText('Nome')).toHaveValue('')
    expect(screen.getByLabelText('Nome')).toHaveAttribute('placeholder', 'Ana Lima')
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Usar a config do git' })).toBeDisabled()
  })

  it('saves an override for Alcy only and can go back to the git config', async () => {
    getGitIdentity.mockResolvedValue({ ok: true, value: fromSystem })
    const overridden: GitIdentityDto = {
      ...fromSystem,
      overrides: { name: null, email: 'ana@work.dev' },
      effective: { name: 'Ana Lima', email: 'ana@work.dev' },
    }
    saveGitIdentity.mockResolvedValueOnce({ ok: true, value: overridden }).mockResolvedValueOnce({ ok: true, value: fromSystem })
    render(<GitIdentitySection />)

    fireEvent.change(await screen.findByLabelText('E-mail'), { target: { value: ' ana@work.dev ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveGitIdentity).toHaveBeenCalledWith({ name: null, email: 'ana@work.dev' }))
    expect(await screen.findByText('Os commits serão assinados por Ana Lima <ana@work.dev>.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Usar a config do git' }))
    await waitFor(() => expect(saveGitIdentity).toHaveBeenLastCalledWith({ name: null, email: null }))
    expect(await screen.findByText('Os commits serão assinados por Ana Lima <ana@example.com>.')).toBeInTheDocument()
    expect(screen.getByLabelText('E-mail')).toHaveValue('')
  })

  it('warns when no complete author is known and shows save errors', async () => {
    getGitIdentity.mockResolvedValue({ ok: true, value: { system: { name: null, email: null }, overrides: { name: null, email: null }, effective: null } })
    saveGitIdentity.mockResolvedValue({ ok: false, error: { kind: 'invalid', message: 'the git user e-mail is invalid' } })
    render(<GitIdentitySection />)

    expect(await screen.findByText(/Sem usuário git completo/)).toBeInTheDocument()
    expect(screen.getByLabelText('Nome')).toHaveAttribute('placeholder', 'Não definido no git')
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'bad mail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('the git user e-mail is invalid')).toBeInTheDocument()
  })
})
