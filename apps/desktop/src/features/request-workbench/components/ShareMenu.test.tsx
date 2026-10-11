import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '../../../test-utils'
import { ShareMenu } from './ShareMenu'

function openMenu() {
  const button = screen.getByRole('button', { name: 'Compartilhar requisição' })
  // O clique real foca o botão antes de abrir o menu; o fireEvent não faz isso sozinho.
  act(() => button.focus())
  fireEvent.click(button)
  return button
}

describe('ShareMenu', () => {
  it('abre o menu com o foco no primeiro item, sem fechá-lo pelo blur do botão', () => {
    render(<ShareMenu onShareAsCode={() => {}} onShareAsImage={() => {}} />)
    openMenu()

    expect(screen.getByRole('menu', { name: 'Compartilhar requisição' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Como código' })).toHaveFocus()
  })

  it('executa a opção escolhida e fecha', () => {
    const onShareAsImage = vi.fn()
    render(<ShareMenu onShareAsCode={() => {}} onShareAsImage={onShareAsImage} />)
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Como imagem' }))

    expect(onShareAsImage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('fecha com Escape e devolve o foco ao botão', () => {
    render(<ShareMenu onShareAsCode={() => {}} onShareAsImage={() => {}} />)
    const button = openMenu()

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Como código' }), { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('fecha quando o foco sai do menu', () => {
    render(<ShareMenu onShareAsCode={() => {}} onShareAsImage={() => {}} />)
    openMenu()

    act(() => screen.getByRole('menuitem', { name: 'Como código' }).blur())

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
