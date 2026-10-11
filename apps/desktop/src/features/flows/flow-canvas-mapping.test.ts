import { describe, expect, it, vi } from 'vitest'
import { snapViewportToWholePixels } from './flow-canvas-mapping'

describe('snapViewportToWholePixels', () => {
  it('arredonda um deslocamento fracionário mantendo o zoom', () => {
    const setViewport = vi.fn().mockResolvedValue(true)

    snapViewportToWholePixels({ setViewport }, { x: 10.4, y: -3.6, zoom: 1.37 })

    expect(setViewport).toHaveBeenCalledWith({ x: 10, y: -4, zoom: 1.37 })
  })

  it('não mexe num deslocamento já inteiro, para não entrar em laço', () => {
    const setViewport = vi.fn().mockResolvedValue(true)

    snapViewportToWholePixels({ setViewport }, { x: 10, y: -4, zoom: 1.37 })

    expect(setViewport).not.toHaveBeenCalled()
  })
})
