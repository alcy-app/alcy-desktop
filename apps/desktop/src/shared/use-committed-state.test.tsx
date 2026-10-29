import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useCommittedState } from './use-committed-state'

function setup(persist = vi.fn<(value: string) => Promise<void>>(async () => {})) {
  const cancelPending = vi.fn()
  const restorePending = vi.fn()
  const hook = renderHook(({ scope, ready, error }: { scope: string; ready: boolean; error: string | null }) => {
    const [value, setValue] = useState('original')
    const commit = useCommittedState({ scope, value, ready, error, persist, cancelPending, apply: setValue, restorePending })
    return { value, setValue, commit }
  }, { initialProps: { scope: '/one', ready: true, error: null } as { scope: string; ready: boolean; error: string | null } })
  return { ...hook, persist, cancelPending, restorePending }
}

describe('explicit state persistence', () => {
  it('publishes a change only after native persistence succeeds', async () => {
    let finish = () => {}
    const h = setup(vi.fn(() => new Promise<void>((resolve) => { finish = resolve })))
    let pending: Promise<void>
    act(() => { pending = h.result.current.commit(() => 'saved') })
    expect(h.result.current.value).toBe('original')
    expect(h.cancelPending).toHaveBeenCalledOnce()
    await act(async () => { finish(); await pending })
    expect(h.result.current.value).toBe('saved')
  })

  it('keeps current state and restores pending autosaves after a native validation failure', async () => {
    const h = setup(vi.fn(async () => { throw new Error('Invalid rule') }))
    await act(async () => { await expect(h.result.current.commit(() => 'invalid')).rejects.toThrow('Invalid rule') })
    expect(h.result.current.value).toBe('original')
    expect(h.restorePending).toHaveBeenCalledOnce()
  })

  it('does not save unreadable or not-yet-loaded data', async () => {
    const h = setup()
    h.rerender({ scope: '/one', ready: false, error: null })
    await expect(h.result.current.commit(() => 'new')).rejects.toThrow('not loaded')
    h.rerender({ scope: '/one', ready: true, error: 'Newer file version' })
    await expect(h.result.current.commit(() => 'new')).rejects.toThrow('Newer file')
    expect(h.persist).not.toHaveBeenCalled()
  })

  it('preserves a concurrent manual edit in memory and restores it on disk', async () => {
    let finish = () => {}
    const persist = vi.fn<(value: string) => Promise<void>>(async () => {})
    persist.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const h = setup(persist)
    let pending: Promise<void>
    act(() => { pending = h.result.current.commit(() => 'agent') })
    act(() => h.result.current.setValue('manual'))
    await act(async () => { finish(); await expect(pending).rejects.toThrow('changed while saving') })
    expect(h.result.current.value).toBe('manual')
    expect(persist.mock.calls.map(([value]) => value)).toEqual(['agent', 'manual'])
  })

  it('does not apply an old save to a different workspace or after unmount', async () => {
    let finish = () => {}
    const h = setup(vi.fn(() => new Promise<void>((resolve) => { finish = resolve })))
    let pending: Promise<void>
    act(() => { pending = h.result.current.commit(() => 'old workspace') })
    h.rerender({ scope: '/two', ready: true, error: null })
    await act(async () => { finish(); await expect(pending).rejects.toThrow('no longer available') })
    expect(h.result.current.value).toBe('original')
    expect(h.restorePending).not.toHaveBeenCalled()
  })
})
