import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDropEvent } from '../../../bindings/on-file-drop'
import { openModals } from '../../../shared/ui/open-modals'
import { render, screen, waitFor } from '../../../test-utils'
import { ImageImportDropOverlay } from './ImageImportDropOverlay'

let dropHandler: ((event: FileDropEvent) => void) | undefined
const unlisten = vi.fn()

vi.mock('../../../bindings/on-file-drop', () => ({
  onFileDrop: (handler: (event: FileDropEvent) => void) => {
    dropHandler = handler
    return Promise.resolve(unlisten)
  },
}))

const emit = (event: FileDropEvent) => act(() => dropHandler?.(event))

async function renderOverlay(onImportFromPath = vi.fn().mockResolvedValue({ ok: true })) {
  const view = render(<ImageImportDropOverlay onImportFromPath={onImportFromPath} />)
  await waitFor(() => expect(dropHandler).toBeDefined())
  return { ...view, onImportFromPath }
}

describe('ImageImportDropOverlay', () => {
  beforeEach(() => {
    dropHandler = undefined
    unlisten.mockReset()
  })

  afterEach(() => {
    openModals.length = 0
  })

  it('avisa ao arrastar um PNG e importa ao soltar', async () => {
    let finish: (value: { ok: true }) => void = () => {}
    const onImportFromPath = vi.fn(() => new Promise<{ ok: true }>((resolve) => (finish = resolve)))
    await renderOverlay(onImportFromPath)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    emit({ type: 'enter', paths: ['/tmp/Listar usuários.PNG'] })
    expect(screen.getByRole('status')).toHaveTextContent('Solte para importar a requisição')

    emit({ type: 'drop', paths: ['/tmp/Listar usuários.PNG', '/tmp/notas.txt'] })
    expect(screen.getByRole('status')).toHaveTextContent('Importando a requisição da imagem…')
    expect(onImportFromPath).toHaveBeenCalledWith('/tmp/Listar usuários.PNG')
    expect(onImportFromPath).toHaveBeenCalledTimes(1)

    await act(async () => finish({ ok: true }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('ignora novos drops enquanto importa', async () => {
    let finish: (value: { ok: true }) => void = () => {}
    const onImportFromPath = vi.fn(() => new Promise<{ ok: true }>((resolve) => (finish = resolve)))
    await renderOverlay(onImportFromPath)

    emit({ type: 'drop', paths: ['/tmp/a.png'] })
    emit({ type: 'drop', paths: ['/tmp/a.png'] })
    expect(onImportFromPath).toHaveBeenCalledTimes(1)

    await act(async () => finish({ ok: true }))
    emit({ type: 'drop', paths: ['/tmp/b.png'] })
    expect(onImportFromPath).toHaveBeenCalledTimes(2)
  })

  it('some ao sair da janela e ignora arquivos que não são PNG', async () => {
    const { onImportFromPath } = await renderOverlay()

    emit({ type: 'enter', paths: ['/tmp/a.png'] })
    emit({ type: 'leave' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    emit({ type: 'enter', paths: ['/tmp/colecao.json'] })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    emit({ type: 'drop', paths: ['/tmp/colecao.json'] })
    expect(onImportFromPath).not.toHaveBeenCalled()
  })

  it('não age com um modal aberto', async () => {
    const { onImportFromPath } = await renderOverlay()
    openModals.push(Symbol('modal'))

    emit({ type: 'enter', paths: ['/tmp/a.png'] })
    emit({ type: 'drop', paths: ['/tmp/a.png'] })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(onImportFromPath).not.toHaveBeenCalled()
  })

  it('mostra o erro da importação', async () => {
    await renderOverlay(vi.fn().mockResolvedValue({ ok: false, message: 'a imagem não tem dados de importação do Alcy' }))

    emit({ type: 'drop', paths: ['/tmp/foto.png'] })

    expect(
      await screen.findByText('Não foi possível importar a imagem: a imagem não tem dados de importação do Alcy'),
    ).toBeInTheDocument()
  })

  it('para de escutar ao desmontar', async () => {
    const { unmount } = await renderOverlay()
    unmount()
    expect(unlisten).toHaveBeenCalled()
  })
})
