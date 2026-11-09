import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLECTIONS_FILE, useExternalFileChanges } from './use-external-file-changes'

const getWorkspaceFileStamps = vi.fn()

vi.mock('../../bindings/get-workspace-file-stamps', () => ({
  getWorkspaceFileStamps: (...args: unknown[]) => getWorkspaceFileStamps(...args),
}))

function diskHas(stamp: string) {
  getWorkspaceFileStamps.mockResolvedValue({ ok: true, value: [{ name: COLLECTIONS_FILE, stamp }] })
}

async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
  })
}

async function setup(hasPendingSave: (name: string) => boolean = () => false) {
  const onChanged = vi.fn()
  diskHas('first')
  const view = renderHook(() => useExternalFileChanges('/workspace', hasPendingSave, onChanged))
  await waitFor(() => expect(getWorkspaceFileStamps).toHaveBeenCalled())
  await act(async () => {
    await Promise.resolve()
  })
  return { onChanged, ...view }
}

describe('useExternalFileChanges', () => {
  beforeEach(() => {
    getWorkspaceFileStamps.mockReset()
  })

  it('does not report what was already on disk when the workspace opened', async () => {
    const { onChanged } = await setup()

    await focusWindow()

    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports a file changed from outside, once', async () => {
    const { onChanged } = await setup()

    diskHas('from-a-teammate')
    await focusWindow()
    await focusWindow()

    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledWith([COLLECTIONS_FILE])
  })

  it('ignores the files Alcy wrote itself', async () => {
    const { onChanged, result } = await setup()

    diskHas('our-autosave')
    await act(async () => {
      result.current.markOwnWrite(COLLECTIONS_FILE)
      await Promise.resolve()
    })
    await focusWindow()

    expect(onChanged).not.toHaveBeenCalled()
  })

  it('waits for an unsaved edit before reporting the change', async () => {
    let pending = true
    const { onChanged } = await setup(() => pending)

    diskHas('from-a-teammate')
    await focusWindow()
    expect(onChanged).not.toHaveBeenCalled()

    pending = false
    await focusWindow()
    expect(onChanged).toHaveBeenCalledWith([COLLECTIONS_FILE])
  })
})
