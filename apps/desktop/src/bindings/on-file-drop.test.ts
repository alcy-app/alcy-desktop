import { afterEach, describe, expect, it, vi } from 'vitest'
import { onFileDrop, type FileDropEvent } from './on-file-drop'

let emit: (payload: FileDropEvent) => void = () => {}

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: FileDropEvent }) => void) => {
      emit = (payload) => handler({ payload })
      return Promise.resolve(() => {})
    },
  }),
}))

describe('onFileDrop', () => {
  afterEach(() => vi.useRealTimers())

  it('descarta as cópias do mesmo drop emitidas pelo Tauri', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    await onFileDrop(handler)

    emit({ type: 'enter', paths: ['/tmp/a.png'] })
    emit({ type: 'drop', paths: ['/tmp/a.png'] })
    emit({ type: 'drop', paths: ['/tmp/a.png'] })
    emit({ type: 'drop', paths: ['/tmp/a.png'] })

    expect(handler.mock.calls.filter(([event]) => event.type === 'drop')).toHaveLength(1)
  })

  it('entrega outro drop com arquivos diferentes ou depois de um tempo', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    await onFileDrop(handler)

    emit({ type: 'drop', paths: ['/tmp/a.png'] })
    emit({ type: 'drop', paths: ['/tmp/b.png'] })
    vi.advanceTimersByTime(1500)
    emit({ type: 'drop', paths: ['/tmp/b.png'] })

    expect(handler).toHaveBeenCalledTimes(3)
  })
})
