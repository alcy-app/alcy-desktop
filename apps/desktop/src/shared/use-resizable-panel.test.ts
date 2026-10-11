import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useResizablePanel } from './use-resizable-panel'

describe('useResizablePanel', () => {
  it('acompanha um maxSize que encolhe sem perder o tamanho escolhido quando o espaço volta', () => {
    const { result, rerender } = renderHook(
      ({ maxSize }) => useResizablePanel({ initialSize: 600, minSize: 280, maxSize, axis: 'horizontal' }),
      { initialProps: { maxSize: 900 } },
    )
    expect(result.current.size).toBe(600)

    rerender({ maxSize: 400 })
    expect(result.current.size).toBe(400)

    rerender({ maxSize: 900 })
    expect(result.current.size).toBe(600)
  })
})

describe('useResizablePanel — arraste', () => {
  it('aplica no máximo um tamanho por quadro e grava o último ao soltar', () => {
    const { result } = renderHook(() =>
      useResizablePanel({ initialSize: 300, minSize: 100, maxSize: 900, axis: 'horizontal', storageKey: 'test:panel' }),
    )

    act(() => {
      result.current.startResizing({ clientX: 0, clientY: 0, preventDefault: () => {} } as never)
    })
    act(() => {
      for (const clientX of [10, 20, 30, 40]) window.dispatchEvent(new MouseEvent('pointermove', { clientX }))
    })
    // Ainda dentro do mesmo quadro: nenhum dos movimentos foi aplicado.
    expect(result.current.size).toBe(300)

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })

    expect(result.current.size).toBe(340)
    expect(window.localStorage.getItem('test:panel')).toBe('340')
  })
})
