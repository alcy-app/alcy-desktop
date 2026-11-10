import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResponseBodyOutput } from '../../../bindings/execute-graphql-request'
import { readResponseBodyChunk } from '../../../bindings/read-response-body-chunk'
import { fireEvent, render, screen, waitFor, within } from '../../../test-utils'
import type { ExecutionState } from '../request-workbench.types'
import { WINDOWED_AUTO_LOAD_MAX_BYTES } from './ResponseBody'
import { ResponsePanel } from './ResponsePanel'

vi.mock('../../../bindings/read-response-body-chunk', () => ({ readResponseBodyChunk: vi.fn() }))

function execution(body: ResponseBodyOutput, contentType = 'application/json'): ExecutionState {
  return {
    status: 'success',
    result: {
      statusCode: 200,
      durationMs: 5,
      sizeBytes: 100,
      body,
      bodyEncoding: 'text',
      headers: [{ name: 'content-type', value: contentType }],
      requestHeaders: [],
      cookies: [],
      connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
      finalUrl: null,
      waitingMs: 0,
      environmentChanges: [],
      scopedChanges: [],
      scriptLogs: [],
      scriptError: null,
      testResults: [],
    },
  }
}

function renderPanel(state: ExecutionState, currentSendId = 'send-1') {
  return render(<ResponsePanel execution={state} currentSendId={currentSendId} onClear={() => {}} layout="bottom" onToggleLayout={() => {}} />)
}

function chooseFormat(label: string) {
  const selector = within(screen.getByRole('group', { name: 'Formato de exibição do corpo' }))
  fireEvent.click(selector.getByRole('button', { expanded: false }))
  fireEvent.click(selector.getByRole('button', { name: label }))
}

const writeText = vi.fn()

describe('ResponsePanel copying', () => {
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined)
    vi.mocked(readResponseBodyChunk).mockReset()
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['application/json', '{"user":{"name":"Ana"},"ids":[1,2]}', '{\n  "user": {\n    "name": "Ana"\n  },\n  "ids": [\n    1,\n    2\n  ]\n}'],
    ['application/xml', '<users><user>Ana</user></users>', '<users>\n  <user>Ana</user>\n</users>'],
    ['text/plain', 'first\r\n\tsecond  \n', 'first\r\n\tsecond  \n'],
    ['text/html', '<html>\n  <body>Hello</body>\n</html>', '<html>\n  <body>Hello</body>\n</html>'],
    ['application/json', '{invalid json', '{invalid json'],
  ])('copies the displayed formatting for %s', async (contentType, body, expected) => {
    renderPanel(execution({ kind: 'inline', body }, contentType))

    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    expect(await screen.findByText('Resposta copiada.')).toBeInTheDocument()
  })

  it('follows manual format changes, including raw text', async () => {
    const body = '{"name":"Ana"}'
    renderPanel(execution({ kind: 'inline', body }))
    chooseFormat('Texto')
    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(body))

    chooseFormat('JSON')
    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('{\n  "name": "Ana"\n}'))
  })

  it('uses the detected format for another send', async () => {
    const { rerender } = renderPanel(execution({ kind: 'inline', body: '{"id":1}' }))
    chooseFormat('Texto')

    rerender(<ResponsePanel execution={execution({ kind: 'inline', body: '<id>2</id>' }, 'application/xml')} currentSendId="send-2" onClear={() => {}} layout="bottom" onToggleLayout={() => {}} />)
    expect(screen.getByRole('button', { expanded: false, name: /XML/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('<id>2</id>'))
  })

  it('collects every chunk before formatting and copying the entire response', async () => {
    vi.mocked(readResponseBodyChunk)
      .mockResolvedValueOnce({ ok: true, value: { chunk: '"name":"Ana"', nextOffset: 13 } })
      .mockResolvedValueOnce({ ok: true, value: { chunk: '}', nextOffset: null } })
    renderPanel(execution({ kind: 'windowed', handle: 'body-1', preview: '{', previewNextOffset: 1, totalBytes: WINDOWED_AUTO_LOAD_MAX_BYTES + 1 }))

    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{\n  "name": "Ana"\n}'))
    expect(readResponseBodyChunk).toHaveBeenNthCalledWith(1, { handle: 'body-1', offset: 1 })
    expect(readResponseBodyChunk).toHaveBeenNthCalledWith(2, { handle: 'body-1', offset: 13 })
  })

  it('does not copy a partial response or report success when a chunk is unavailable', async () => {
    vi.mocked(readResponseBodyChunk).mockResolvedValue({ ok: false, error: { kind: 'notFound' } })
    renderPanel(execution({ kind: 'windowed', handle: 'body-1', preview: '{', previewNextOffset: 1, totalBytes: WINDOWED_AUTO_LOAD_MAX_BYTES + 1 }))

    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))

    await waitFor(() => expect(readResponseBodyChunk).toHaveBeenCalledOnce())
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByText('Resposta copiada.')).not.toBeInTheDocument()
  })

  it('does not report success when the clipboard is unavailable', async () => {
    writeText.mockRejectedValue(new Error('Clipboard unavailable'))
    renderPanel(execution({ kind: 'inline', body: '{"id":1}' }))

    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.queryByText('Resposta copiada.')).not.toBeInTheDocument()
  })
})
