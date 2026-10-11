import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

function Stack({ inner, onOuterEscape, onInnerEscape }: { inner: boolean; onOuterEscape: () => void; onInnerEscape: () => void }) {
  return (
    <Modal title="Externo" closeAriaLabel="Fechar externo" onClose={() => {}} onEscape={onOuterEscape}>
      <button>fora</button>
      {inner && (
        <Modal title="Interno" closeAriaLabel="Fechar interno" onClose={() => {}} onEscape={onInnerEscape}>
          <button>dentro</button>
        </Modal>
      )}
    </Modal>
  )
}

describe('Modal', () => {
  it('só o modal do topo responde ao Escape quando um modal abre sobre outro', () => {
    const onOuterEscape = vi.fn()
    const onInnerEscape = vi.fn()
    const { rerender } = render(<Stack inner={false} onOuterEscape={onOuterEscape} onInnerEscape={onInnerEscape} />)
    rerender(<Stack inner onOuterEscape={onOuterEscape} onInnerEscape={onInnerEscape} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'dentro' }), { key: 'Escape' })
    expect(onInnerEscape).toHaveBeenCalledTimes(1)
    expect(onOuterEscape).not.toHaveBeenCalled()

    rerender(<Stack inner={false} onOuterEscape={onOuterEscape} onInnerEscape={onInnerEscape} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'fora' }), { key: 'Escape' })
    expect(onOuterEscape).toHaveBeenCalledTimes(1)
  })

  it('foca o painel ao abrir e confirma com Enter vindo do painel ou de um campo de texto', () => {
    const onEnter = vi.fn()
    render(
      <Modal title="Confirmar" closeAriaLabel="Fechar" onClose={() => {}} onEnter={onEnter}>
        <input aria-label="Nome" />
        <textarea aria-label="Notas" />
        <button>Cancelar</button>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(screen.getByLabelText('Nome'), { key: 'Enter' })
    expect(onEnter).toHaveBeenCalledTimes(2)

    // Botões, áreas de texto, Enter com modificador ou repetido não confirmam.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancelar' }), { key: 'Enter' })
    fireEvent.keyDown(screen.getByLabelText('Notas'), { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(dialog, { key: 'Enter', repeat: true })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onEnter).toHaveBeenCalledTimes(2)
  })

  it('não rouba o foco de um filho com autoFocus e respeita Enter já tratado', () => {
    const onEnter = vi.fn()
    render(
      <Modal title="Salvar" closeAriaLabel="Fechar" onClose={() => {}} onEnter={onEnter}>
        <input aria-label="Nome" autoFocus onKeyDown={(event) => event.preventDefault()} />
      </Modal>,
    )

    const input = screen.getByLabelText('Nome')
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEnter).not.toHaveBeenCalled()
  })

  it('só o modal do topo confirma com Enter', () => {
    const onOuterEnter = vi.fn()
    const onInnerEnter = vi.fn()
    const stack = (inner: boolean) => (
      <Modal title="Externo" closeAriaLabel="Fechar externo" onClose={() => {}} onEnter={onOuterEnter}>
        {inner && (
          <Modal title="Interno" closeAriaLabel="Fechar interno" onClose={() => {}} onEnter={onInnerEnter}>
            <p>dentro</p>
          </Modal>
        )}
      </Modal>
    )
    const { rerender } = render(stack(false))
    rerender(stack(true))

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Interno' }), { key: 'Enter' })
    expect(onInnerEnter).toHaveBeenCalledTimes(1)
    expect(onOuterEnter).not.toHaveBeenCalled()
  })
})
