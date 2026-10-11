import { describe, expect, it, vi } from 'vitest'
import { registerBeforeExit, runBeforeExit } from './before-exit'

describe('before-exit', () => {
  it('executa os handlers registrados, mesmo se um deles falhar', async () => {
    const first = vi.fn(() => Promise.reject(new Error('falhou')))
    const second = vi.fn()
    const unregisterFirst = registerBeforeExit(first)
    const unregisterSecond = registerBeforeExit(second)

    await runBeforeExit()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    unregisterFirst()
    unregisterSecond()
  })

  it('não executa handlers removidos', async () => {
    const handler = vi.fn()
    registerBeforeExit(handler)()

    await runBeforeExit()

    expect(handler).not.toHaveBeenCalled()
  })
})
