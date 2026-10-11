import { describe, expect, it, vi } from 'vitest'
import type { ReadResponseBodyChunkResult } from '../../../bindings/read-response-body-chunk'
import * as readResponseBodyChunkModule from '../../../bindings/read-response-body-chunk'
import { fireEvent, render, screen, waitFor, within } from '../../../test-utils'
import * as jsonFormat from '../json-format'
import { ResponseBody, WINDOWED_AUTO_LOAD_MAX_BYTES } from './ResponseBody'

const ABOVE_AUTO_LOAD_CAP = WINDOWED_AUTO_LOAD_MAX_BYTES + 1

const FORMAT_SELECTOR_NAME = 'Formato de exibição do corpo'

const FORMAT_LABELS = { json: 'JSON', xml: 'XML', html: 'HTML', text: 'Texto' }

function formatOption(format: keyof typeof FORMAT_LABELS) {
  return within(screen.getByRole('radiogroup', { name: FORMAT_SELECTOR_NAME })).getByRole('radio', {
    name: FORMAT_LABELS[format],
  })
}

describe('ResponseBody', () => {
  it('formata e destaca sintaxe para corpo JSON inline', () => {
    render(<ResponseBody body={{ kind: 'inline', body: '{"name":"ana"}' }} bodyEncoding="text" headers={[]} />)

    expect(screen.getByText('"name"')).toBeInTheDocument()
    expect(screen.getByText('"ana"')).toBeInTheDocument()
    expect(formatOption('json')).toBeChecked()
  })

  it('não reprocessa a formatação quando o corpo não muda entre renders', () => {
    const formatSpy = vi.spyOn(jsonFormat, 'formatJsonBody')
    formatSpy.mockClear()

    const body = { kind: 'inline' as const, body: '{"a":1}' }
    const { rerender } = render(<ResponseBody body={body} bodyEncoding="text" headers={[]} />)
    expect(formatSpy).toHaveBeenCalledTimes(1)

    rerender(<ResponseBody body={body} bodyEncoding="text" headers={[]} />)
    expect(formatSpy).toHaveBeenCalledTimes(1)

    rerender(<ResponseBody body={{ kind: 'inline', body: '{"a":2}' }} bodyEncoding="text" headers={[]} />)
    expect(formatSpy).toHaveBeenCalledTimes(2)

    formatSpy.mockRestore()
  })

  it('formata e destaca sintaxe para corpos JSON grandes, sem degradar (CodeMirror virtualiza)', () => {
    const largeValue = 'a'.repeat(500 * 1024)
    const largeBody = `{"value":"${largeValue}"}`
    const { container } = render(<ResponseBody body={{ kind: 'inline', body: largeBody }} bodyEncoding="text" headers={[]} />)

    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(screen.getByText('"value"')).toBeInTheDocument()
  })

  it('detecta XML pelo Content-Type, formata e destaca a sintaxe', () => {
    render(
      <ResponseBody
        body={{ kind: 'inline', body: '<root><name>ana</name></root>' }}
        bodyEncoding="text"
        headers={[{ name: 'Content-Type', value: 'application/xml; charset=utf-8' }]}
      />,
    )

    expect(screen.getAllByText('root').length).toBeGreaterThan(0)
    expect(screen.getAllByText('name').length).toBeGreaterThan(0)
    expect(formatOption('xml')).toBeChecked()
  })

  it('alterna para texto bruto ao escolher "Texto" no seletor de formato', () => {
    render(
      <ResponseBody
        body={{ kind: 'inline', body: '<root><name>ana</name></root>' }}
        bodyEncoding="text"
        headers={[{ name: 'Content-Type', value: 'application/xml' }]}
      />,
    )

    fireEvent.click(formatOption('text'))

    expect(screen.getByText('<root><name>ana</name></root>')).toBeInTheDocument()
  })

  it('permite forçar um formato diferente do detectado (JSON visto como XML)', () => {
    render(<ResponseBody body={{ kind: 'inline', body: '{"name":"ana"}' }} bodyEncoding="text" headers={[]} />)

    expect(formatOption('json')).toBeChecked()

    fireEvent.click(formatOption('xml'))

    expect(screen.getByText('{"name":"ana"}')).toBeInTheDocument()
  })

  it('detecta HTML pelo Content-Type e renderiza um preview isolado por padrão', () => {
    const { container } = render(
      <ResponseBody
        body={{ kind: 'inline', body: '<p>ola</p>' }}
        bodyEncoding="text"
        headers={[{ name: 'Content-Type', value: 'text/html' }]}
      />,
    )

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe).toHaveAttribute('sandbox', '')
    expect(iframe).toHaveAttribute('srcdoc', '<p>ola</p>')
    expect(formatOption('html')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('alterna do preview de HTML para o código ao desligar "Preview"', () => {
    const { container } = render(
      <ResponseBody
        body={{ kind: 'inline', body: '<p>ola</p>' }}
        bodyEncoding="text"
        headers={[{ name: 'Content-Type', value: 'text/html' }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('<p>ola</p>')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('o botão "Preview" só aparece quando o formato selecionado é HTML', () => {
    render(<ResponseBody body={{ kind: 'inline', body: '{"a":1}' }} bodyEncoding="text" headers={[]} />)

    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
  })

  it('mostra o seletor de formato (em "Texto") mesmo quando o corpo não é JSON nem XML', () => {
    render(
      <ResponseBody
        body={{ kind: 'inline', body: 'não é json nem xml' }}
        bodyEncoding="text"
        headers={[{ name: 'Content-Type', value: 'text/plain' }]}
      />,
    )

    expect(screen.getByText('não é json nem xml')).toBeInTheDocument()
    expect(formatOption('text')).toBeChecked()
  })

  it('renderiza uma imagem a partir de um corpo base64 inline, ignorando o seletor de formato', () => {
    const { container } = render(
      <ResponseBody
        body={{ kind: 'inline', body: 'aGVsbG8=' }}
        bodyEncoding="base64"
        headers={[{ name: 'Content-Type', value: 'image/png' }]}
      />,
    )

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  describe('corpo windowed', () => {
    function mockChunk(result: ReadResponseBodyChunkResult) {
      return vi.spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk').mockResolvedValue(result)
    }

    it('acima do teto de auto-carregamento, mostra o preview e espera clique (sem chamar o backend sozinho)', () => {
      const readSpy = mockChunk({ ok: true, value: { chunk: '', nextOffset: null } })

      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: ABOVE_AUTO_LOAD_CAP, preview: 'primeiro pedaço', previewNextOffset: 40 }}
          bodyEncoding="text"
          headers={[]}
        />,
      )

      expect(screen.getByText('Resposta muito grande - exibida em partes.')).toBeInTheDocument()
      expect(screen.getByText('primeiro pedaço')).toBeInTheDocument()
      expect(formatOption('text')).toBeChecked()
      expect(readSpy).not.toHaveBeenCalled()

      readSpy.mockRestore()
    })

    it('outro corpo windowed (outra aba ou envio) não herda o texto já carregado do anterior', async () => {
      const readSpy = vi
        .spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk')
        .mockImplementation(async ({ handle }) => ({ ok: true, value: { chunk: `+${handle}`, nextOffset: null } }))

      const { rerender } = render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'tab-a', totalBytes: 999, preview: 'A', previewNextOffset: 1 }}
          bodyEncoding="text"
          headers={[]}
        />,
      )
      expect(await screen.findByText('A+tab-a')).toBeInTheDocument()

      rerender(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'tab-b', totalBytes: 999, preview: 'B', previewNextOffset: 1 }}
          bodyEncoding="text"
          headers={[]}
        />,
      )

      expect(await screen.findByText('B+tab-b')).toBeInTheDocument()
      expect(screen.queryByText(/A\+tab-a/)).not.toBeInTheDocument()
      readSpy.mockRestore()
    })

    it('dentro do teto de auto-carregamento, busca todos os chunks sozinho, sem clique', async () => {
      const readSpy = vi
        .spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk')
        .mockResolvedValueOnce({ ok: true, value: { chunk: '-b', nextOffset: 80 } })
        .mockResolvedValueOnce({ ok: true, value: { chunk: '-c', nextOffset: null } })

      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: 999, preview: 'a', previewNextOffset: 40 }}
          bodyEncoding="text"
          headers={[]}
        />,
      )

      expect(screen.getByText('Carregando resposta completa em segundo plano…')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Mostrar mais' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Mostrar tudo' })).not.toBeInTheDocument()

      expect(await screen.findByText('a-b-c')).toBeInTheDocument()
      expect(readSpy).toHaveBeenNthCalledWith(1, { handle: 'exec-1', offset: 40 })
      expect(readSpy).toHaveBeenNthCalledWith(2, { handle: 'exec-1', offset: 80 })
      expect(screen.queryByText('Carregando resposta completa em segundo plano…')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Mostrar mais' })).not.toBeInTheDocument()

      readSpy.mockRestore()
    })

    it('durante o auto-carregamento, exibe o JSON parcial já indentado', async () => {
      let resolveLast: (value: ReadResponseBodyChunkResult) => void = () => {}
      const readSpy = vi
        .spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk')
        .mockResolvedValueOnce({ ok: true, value: { chunk: '{"id":1},{"id"', nextOffset: 80 } })
        .mockImplementationOnce(() => new Promise((resolve) => { resolveLast = resolve }))

      const { container } = render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: 999, preview: '{"items":[', previewNextOffset: 40 }}
          bodyEncoding="text"
          headers={[{ name: 'Content-Type', value: 'application/json' }]}
        />,
      )

      await waitFor(() => expect(readSpy).toHaveBeenCalledTimes(2))
      expect(screen.getByText('Carregando resposta completa em segundo plano…')).toBeInTheDocument()
      expect(container.querySelectorAll('.cm-line').length).toBeGreaterThan(1)

      resolveLast({ ok: true, value: { chunk: ':2}]}', nextOffset: null } })
      await waitFor(() => expect(screen.queryByText('Carregando resposta completa em segundo plano…')).not.toBeInTheDocument())
      expect(container.querySelectorAll('.cm-line')).toHaveLength(10)

      readSpy.mockRestore()
    })

    it('quando o auto-carregamento falha no meio do caminho, cai para o modo manual com erro', async () => {
      const readSpy = vi
        .spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk')
        .mockResolvedValue({ ok: false, error: { kind: 'notFound' } })

      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: 999, preview: 'a', previewNextOffset: 40 }}
          bodyEncoding="text"
          headers={[]}
        />,
      )

      await waitFor(() =>
        expect(
          screen.getByText('Não foi possível carregar mais da resposta - tente novamente.'),
        ).toBeInTheDocument(),
      )
      expect(screen.getByText('a')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Mostrar mais' })).toBeInTheDocument()

      readSpy.mockRestore()
    })

    it('busca o próximo chunk via readResponseBodyChunk ao clicar em "Mostrar mais"', async () => {
      const readSpy = mockChunk({ ok: true, value: { chunk: ' segundo pedaço', nextOffset: null } })

      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: ABOVE_AUTO_LOAD_CAP, preview: 'primeiro pedaço', previewNextOffset: 40 }}
          bodyEncoding="text"
          headers={[]}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }))

      expect(await screen.findByText('primeiro pedaço segundo pedaço')).toBeInTheDocument()
      expect(readSpy).toHaveBeenCalledWith({ handle: 'exec-1', offset: 40 })
      expect(screen.queryByRole('button', { name: 'Mostrar mais' })).not.toBeInTheDocument()

      readSpy.mockRestore()
    })

    it('busca chunks em sequência até esgotar ao clicar em "Mostrar tudo", formatando o resultado final', async () => {
      const readSpy = vi
        .spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk')
        .mockResolvedValueOnce({ ok: true, value: { chunk: '2}', nextOffset: 80 } })
        .mockResolvedValueOnce({ ok: true, value: { chunk: '', nextOffset: null } })

      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: ABOVE_AUTO_LOAD_CAP, preview: '{"a":1', previewNextOffset: 40 }}
          bodyEncoding="text"
          headers={[{ name: 'Content-Type', value: 'application/json' }]}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Mostrar tudo' }))

      expect(await screen.findByText('"a"')).toBeInTheDocument()
      expect(readSpy).toHaveBeenCalledTimes(2)
      expect(readSpy).toHaveBeenNthCalledWith(1, { handle: 'exec-1', offset: 40 })
      expect(readSpy).toHaveBeenNthCalledWith(2, { handle: 'exec-1', offset: 80 })
      expect(screen.queryByRole('button', { name: 'Mostrar mais' })).not.toBeInTheDocument()

      readSpy.mockRestore()
    })

    it('mostra uma mensagem de erro sem quebrar o painel quando a leitura falha', async () => {
      const readSpy = mockChunk({ ok: false, error: { kind: 'notFound' } })

      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: ABOVE_AUTO_LOAD_CAP, preview: 'a', previewNextOffset: 40 }}
          bodyEncoding="text"
          headers={[]}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }))

      await waitFor(() =>
        expect(
          screen.getByText('Não foi possível carregar mais da resposta - tente novamente.'),
        ).toBeInTheDocument(),
      )
      expect(screen.getByText('a')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Mostrar mais' })).toBeInTheDocument()

      readSpy.mockRestore()
    })

    it('não mostra ações nem preview vazio quando o preview já cobre o corpo inteiro', () => {
      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-1', totalBytes: 1, preview: 'tudo', previewNextOffset: null }}
          bodyEncoding="text"
          headers={[]}
        />,
      )

      expect(screen.getByText('tudo')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Mostrar mais' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Mostrar tudo' })).not.toBeInTheDocument()
    })

    it('imagem windowed: exige o clique em "Carregar imagem" antes de montar a <img>', async () => {
      const readSpy = vi.spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk').mockResolvedValue({
        ok: true,
        value: { chunk: 'bmc=', nextOffset: null },
      })

      const { container } = render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-img', totalBytes: 999, preview: 'aGVsbG8=', previewNextOffset: 8 }}
          bodyEncoding="base64"
          headers={[{ name: 'Content-Type', value: 'image/png' }]}
        />,
      )

      expect(container.querySelector('img')).toBeNull()
      const button = screen.getByRole('button', { name: 'Carregar imagem' })

      fireEvent.click(button)

      const img = await screen.findByRole('img', { name: 'Imagem da resposta' })
      expect(img).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=bmc=')
      expect(readSpy).toHaveBeenCalledWith({ handle: 'exec-img', offset: 8 })

      readSpy.mockRestore()
    })

    it('imagem windowed: mostra erro sem quebrar quando o carregamento falha', async () => {
      const readSpy = vi
        .spyOn(readResponseBodyChunkModule, 'readResponseBodyChunk')
        .mockResolvedValue({ ok: false, error: { kind: 'notFound' } })

      render(
        <ResponseBody
          body={{ kind: 'windowed', handle: 'exec-img', totalBytes: 999, preview: 'aGVsbG8=', previewNextOffset: 8 }}
          bodyEncoding="base64"
          headers={[{ name: 'Content-Type', value: 'image/png' }]}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Carregar imagem' }))

      await waitFor(() =>
        expect(
          screen.getByText('Não foi possível carregar mais da resposta - tente novamente.'),
        ).toBeInTheDocument(),
      )
      expect(screen.getByRole('button', { name: 'Carregar imagem' })).toBeInTheDocument()

      readSpy.mockRestore()
    })
  })
})
