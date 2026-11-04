import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import * as formatOffMainThreadModule from '../format-off-main-thread'
import { ResponseCodeView, WORKER_FORMAT_THRESHOLD_BYTES } from './ResponseCodeView'

function repeatToExceedThreshold(char: string): string {
  return char.repeat(WORKER_FORMAT_THRESHOLD_BYTES + 1024)
}

describe('ResponseCodeView', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('formata de forma síncrona corpos abaixo do limiar do worker', () => {
    render(<ResponseCodeView text='{"a":1}' language="json" />)
    expect(screen.getByText('"a"')).toBeInTheDocument()
  })

  it('mantém o body somente leitura, mas permite foco e posicionamento do cursor', () => {
    render(<ResponseCodeView text='{"a":1}' language="json" />)

    const editor = screen.getByRole('textbox', { name: 'Corpo da resposta' })
    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(editor).toHaveAttribute('aria-readonly', 'true')
  })

  it('seleciona a linha inteira pela margem e permite copiá-la pelo menu de contexto', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    const { container } = render(<ResponseCodeView text='{"first":1,"second":2}' language="json" />)
    const secondLineNumber = [...container.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')].find(
      (element) => element.textContent === '2',
    )
    expect(secondLineNumber).toBeDefined()

    fireEvent.mouseDown(secondLineNumber!, { button: 0 })
    fireEvent.contextMenu(container.querySelector('.cm-content')!, { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('  "first": 1,'))
  })

  it('permite recolher e reabrir objetos JSON pelo gutter', async () => {
    const { container } = render(<ResponseCodeView text='{"data":{"value":1}}' language="json" />)
    const foldMarker = [...container.querySelectorAll<HTMLElement>('.cm-foldGutter .cm-gutterElement')].find(
      (element) => element.textContent?.trim() === '⌄',
    )
    expect(foldMarker).toBeDefined()

    fireEvent.click(foldMarker!)
    await waitFor(() => expect(container.querySelector('.cm-foldPlaceholder')).toBeInTheDocument())

    fireEvent.click(container.querySelector('.cm-foldPlaceholder')!)
    await waitFor(() => expect(container.querySelector('.cm-foldPlaceholder')).not.toBeInTheDocument())
  })

  it('acima do limiar do worker, mostra o texto bruto (uma linha) e troca para o formatado (indentado) quando a formatação resolve', async () => {
    const text = `{"value":"${repeatToExceedThreshold('a')}"}`

    const { container } = render(<ResponseCodeView text={text} language="json" />)

    // Bruto: highlighting já se aplica (o JSON já é sintaticamente válido),
    // mas ainda é uma linha só — sem o pretty-print que a formatação injeta.
    expect(container.querySelectorAll('.cm-line')).toHaveLength(1)

    await waitFor(() => expect(container.querySelectorAll('.cm-line').length).toBeGreaterThan(1))
    expect(container.querySelector('.cm-content')).toHaveAttribute('data-language', 'json')
  })

  it('descarta uma formatação pendente quando o texto muda antes dela resolver', async () => {
    let resolveStale: (value: string) => void = () => {}
    const stale = new Promise<string>((resolve) => {
      resolveStale = resolve
    })

    const spy = vi.spyOn(formatOffMainThreadModule, 'formatOffMainThread')
    spy.mockImplementationOnce(() => stale)
    spy.mockImplementationOnce(() => Promise.resolve('TEXTO-ATUAL-FORMATADO'))

    const staleText = `{"x":"${repeatToExceedThreshold('a')}"}`
    const currentText = `{"x":"${repeatToExceedThreshold('b')}"}`

    const { rerender } = render(<ResponseCodeView text={staleText} language="json" />)
    rerender(<ResponseCodeView text={currentText} language="json" />)

    await screen.findByText('TEXTO-ATUAL-FORMATADO')

    resolveStale('TEXTO-ANTIGO-FORMATADO')
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))

    expect(screen.queryByText('TEXTO-ANTIGO-FORMATADO')).not.toBeInTheDocument()
    expect(screen.getByText('TEXTO-ATUAL-FORMATADO')).toBeInTheDocument()

    spy.mockRestore()
  })

  it('com `partial`, indenta JSON truncado em vez de exibi-lo como uma linha só', () => {
    const { container } = render(<ResponseCodeView text='{"data":{"items":[{"id":1},{"na' language="json" partial />)

    expect(container.querySelectorAll('.cm-line').length).toBeGreaterThan(1)
  })

  it('no carregamento progressivo acima do limiar, mantém o formatado anterior até o novo resolver', async () => {
    let resolveSecond: (value: string) => void = () => {}
    const spy = vi.spyOn(formatOffMainThreadModule, 'formatOffMainThread')
    spy.mockImplementationOnce(() => Promise.resolve('PRIMEIRO\nFORMATADO'))
    spy.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveSecond = resolve }))

    const firstText = `{"x":"${repeatToExceedThreshold('a')}`
    const { container, rerender } = render(<ResponseCodeView text={firstText} language="json" partial />)
    await screen.findByText('PRIMEIRO')

    rerender(<ResponseCodeView text={`${firstText}a"}`} language="json" />)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(screen.getByText('PRIMEIRO')).toBeInTheDocument()
    expect(container.querySelectorAll('.cm-line')).toHaveLength(2)

    resolveSecond('SEGUNDO\nFORMATADO')
    await screen.findByText('SEGUNDO')

    spy.mockRestore()
  })

  it('não usa margem sticky, que deixava de ser repintada em rolagem rápida', () => {
    const { container } = render(<ResponseCodeView text='{"a":1}' language="json" />)

    expect(container.querySelector<HTMLElement>('.cm-gutters')!.style.position).not.toBe('sticky')
  })

  it('copia a seleção pelo menu de contexto mesmo sem valor sob o clique', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { container } = render(<ResponseCodeView text='{"a":1}' language="json" onCaptureValue={vi.fn()} />)

    fireEvent.contextMenu(container.querySelector('.cm-content')!, { clientX: 40, clientY: 60 })

    // Sem seleção e sem valor sob o clique (jsdom não tem layout), nada a copiar.
    expect(screen.getByRole('menuitem', { name: 'Copiar' })).toBeDisabled()
  })

  it('não oferece captura sem o callback', () => {
    const { container } = render(<ResponseCodeView text='{"a":1}' language="json" />)

    fireEvent.contextMenu(container.querySelector('.cm-content')!, { clientX: 40, clientY: 60 })

    expect(screen.getByRole('menuitem', { name: 'Copiar' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Capturar em script de resposta' })).not.toBeInTheDocument()
  })

  it('não oferece captura fora de um valor JSON', () => {
    const { container } = render(<ResponseCodeView text='{"a":1}' language="json" onCaptureValue={vi.fn()} />)

    // jsdom não tem layout: `posAtCoords` não acha nenhum valor sob o clique.
    fireEvent.contextMenu(container.querySelector('.cm-content')!, { clientX: 40, clientY: 60 })

    expect(screen.queryByRole('menuitem', { name: 'Capturar em script de resposta' })).not.toBeInTheDocument()
  })

  it('shares the selected lines as an image excerpt, numbered and colored as in the view', () => {
    const onShareSelection = vi.fn()
    const { container } = render(<ResponseCodeView text='{"first":1,"second":2}' language="json" onShareSelection={onShareSelection} />)
    const secondLineNumber = [...container.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')].find(
      (element) => element.textContent === '2',
    )

    fireEvent.mouseDown(secondLineNumber!, { button: 0 })
    fireEvent.contextMenu(container.querySelector('.cm-content')!, { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compartilhar como imagem' }))

    expect(onShareSelection).toHaveBeenCalledWith(expect.objectContaining({ firstLine: 2, lines: ['"first": 1,'], language: 'json' }))
    expect(onShareSelection.mock.calls[0][0].spans[0][0]).toEqual({ text: '"first"', tone: 'key' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('offers sharing as an image only for a selection and with the callback', () => {
    const openMenu = (container: HTMLElement, selectLine: boolean) => {
      const line = [...container.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')].find((element) => element.textContent === '2')
      if (selectLine) fireEvent.mouseDown(line!, { button: 0 })
      fireEvent.contextMenu(container.querySelector('.cm-content')!, { clientX: 40, clientY: 60 })
    }
    const shareItem = () => screen.queryByRole('menuitem', { name: 'Compartilhar como imagem' })

    const withCallback = render(<ResponseCodeView text='{"a":1}' language="json" onShareSelection={vi.fn()} />)
    openMenu(withCallback.container, false)
    expect(shareItem()).not.toBeInTheDocument()
    withCallback.unmount()

    const withoutCallback = render(<ResponseCodeView text='{"a":1}' language="json" />)
    openMenu(withoutCallback.container, true)
    expect(screen.getByRole('menuitem', { name: 'Copiar' })).toBeEnabled()
    expect(shareItem()).not.toBeInTheDocument()
  })
})
