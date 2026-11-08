import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import type { WorkspaceLinkDto } from '../../bindings/version-control-types'
import { GitStatusButton } from './GitStatusButton'
import type { VersionSummary } from './version-summary'

const link: WorkspaceLinkDto = { includeEnvironments: false }
const counts = { local: 3, remote: 0, conflicts: 2 }

const renderButton = (
  summary: VersionSummary,
  callbacks = { onOpenPanel: () => {}, onPull: () => {}, onRefresh: () => {} },
) => render(<GitStatusButton summary={summary} counts={counts} link={link} checking={false} busy={null} {...callbacks} />)

describe('GitStatusButton', () => {
  it.each([
    ['unlinked', 'Workspace sem vínculo com um repositório'],
    ['loading', 'Verificando o estado…'],
    ['busy', 'Sincronizando…'],
    ['error', 'Não foi possível verificar o estado'],
    ['clean', 'Sincronizado com Git'],
    ['changes', '3 alteração(ões) local(is) em Git'],
    ['remoteAhead', 'Há atualizações no remoto (Git)'],
    ['conflict', 'Conflito em Git'],
  ] as const)('descreve o estado %s no rótulo acessível', (summary, description) => {
    renderButton(summary)
    expect(screen.getByRole('button', { name: `Controle de versão: ${description}. Abrir ações do Git` })).toHaveAttribute(
      'data-state',
      summary,
    )
  })

  it('mostra a contagem de alterações locais ou de conflitos', () => {
    const { unmount } = renderButton('changes')
    expect(screen.getByText('3')).toBeInTheDocument()
    unmount()

    renderButton('conflict')
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('não mostra contagem quando sincronizado', () => {
    renderButton('clean')
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })

  it('abre as ações e encaminha Pull, Verificar e Push', () => {
    const callbacks = { onOpenPanel: vi.fn(), onPull: vi.fn(), onRefresh: vi.fn() }
    renderButton('clean', callbacks)
    fireEvent.click(screen.getByRole('button', { name: /Controle de versão/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull' }))
    expect(callbacks.onPull).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Controle de versão/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Verificar' }))
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Controle de versão/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Push' }))
    expect(callbacks.onOpenPanel).toHaveBeenCalledTimes(1)
  })
})
