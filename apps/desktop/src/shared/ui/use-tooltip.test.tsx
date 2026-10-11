import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { IconButton } from './IconButton'
import { Tooltip } from './Tooltip'
import { TOOLTIP_DELAY_MS, computeTooltipPosition } from './use-tooltip'

const VIEWPORT = { width: 800, height: 600 }
const TOOLTIP = { width: 100, height: 24 }

describe('computeTooltipPosition', () => {
  it('centraliza abaixo do alvo', () => {
    const anchor = { top: 100, left: 300, width: 20, height: 20 }
    expect(computeTooltipPosition(anchor, TOOLTIP, 'bottom', VIEWPORT)).toEqual({ top: 126, left: 260 })
  })

  it('abre acima quando não cabe abaixo', () => {
    const anchor = { top: 580, left: 300, width: 20, height: 20 }
    expect(computeTooltipPosition(anchor, TOOLTIP, 'bottom', VIEWPORT).top).toBe(580 - 6 - 24)
  })

  it('fica dentro da janela perto das bordas laterais', () => {
    const nearLeft = { top: 100, left: 0, width: 20, height: 20 }
    const nearRight = { top: 100, left: 790, width: 10, height: 20 }
    expect(computeTooltipPosition(nearLeft, TOOLTIP, 'bottom', VIEWPORT).left).toBe(8)
    expect(computeTooltipPosition(nearRight, TOOLTIP, 'bottom', VIEWPORT).left).toBe(800 - 100 - 8)
  })

  it('troca para a esquerda quando não cabe à direita', () => {
    const anchor = { top: 100, left: 750, width: 20, height: 20 }
    expect(computeTooltipPosition(anchor, TOOLTIP, 'right', VIEWPORT).left).toBe(750 - 6 - 100)
  })
})

describe('tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const waitDelay = () =>
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    })

  it('mostra o label do IconButton só depois do atraso e esconde ao sair', () => {
    render(<IconButton icon={<span />} label="Remover cabeçalho" />)
    const button = screen.getByRole('button', { name: 'Remover cabeçalho' })

    fireEvent.mouseEnter(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    waitDelay()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Remover cabeçalho')

    fireEvent.mouseLeave(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('esconde ao clicar e com Escape', () => {
    render(<IconButton icon={<span />} label="Fechar" />)
    const button = screen.getByRole('button', { name: 'Fechar' })

    fireEvent.mouseEnter(button)
    waitDelay()
    fireEvent.pointerDown(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseLeave(button)
    fireEvent.mouseEnter(button)
    waitDelay()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('não mostra nada com tooltip desligado e preserva os handlers recebidos', () => {
    const onMouseEnter = vi.fn()
    render(<IconButton icon={<span />} label="Formatar" tooltip={false} onMouseEnter={onMouseEnter} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Formatar' }))
    waitDelay()
    expect(onMouseEnter).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('abre pelo foco do teclado, exceto em hoverOnly', () => {
    render(
      <>
        <Tooltip label="Com foco">
          <button type="button">a</button>
        </Tooltip>
        <Tooltip label="Só hover" hoverOnly>
          <button type="button">b</button>
        </Tooltip>
      </>,
    )

    const withFocus = screen.getByRole('button', { name: 'a' })
    const hoverOnly = screen.getByRole('button', { name: 'b' })

    // Foco sem teclado (como o que segue um clique) não abre o tooltip.
    act(() => withFocus.focus())
    waitDelay()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => withFocus.blur())

    fireEvent.keyDown(document, { key: 'Tab' })
    act(() => hoverOnly.focus())
    waitDelay()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Tab' })
    act(() => withFocus.focus())
    waitDelay()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Com foco')
  })

  it('quebra linhas longas na variante multiline', () => {
    render(
      <Tooltip label="https://api.example.com/v1/um/caminho/bem/longo" multiline>
        <span>url</span>
      </Tooltip>,
    )
    fireEvent.mouseEnter(screen.getByText('url').parentElement!)
    waitDelay()
    expect(screen.getByRole('tooltip')).toHaveClass('ui-tooltip--multiline')
  })
})
