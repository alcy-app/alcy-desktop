import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import type { ExecuteRestRequestOutput } from '../../../bindings/execute-rest-request'
import type { ExecutionState } from '../request-workbench.types'
import { ScriptsPanel } from './ScriptsPanel'

const successOutput = (overrides: Partial<ExecuteRestRequestOutput>): ExecutionState => ({
  status: 'success',
  result: {
    statusCode: 200,
    durationMs: 1,
    sizeBytes: 2,
    body: { kind: 'inline', body: '{}' },
    bodyEncoding: 'text',
    headers: [],
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
    ...overrides,
  },
})

function renderPanel(execution: ExecutionState = { status: 'idle' }) {
  return render(
    <ScriptsPanel
      preRequestScript="al.request.url = 'x'"
      postResponseScript="al.console.log(1)"
      onPreRequestScriptChange={vi.fn()}
      onPostResponseScriptChange={vi.fn()}
      execution={execution}
    />,
  )
}

describe('ScriptsPanel', () => {
  it('mostra o script de pré-requisição e alterna para o de pós-resposta', () => {
    renderPanel()

    expect(screen.getByRole('textbox', { name: 'Script de pré-requisição' })).toHaveTextContent("al.request.url = 'x'")

    fireEvent.click(screen.getByRole('tab', { name: 'Pós-resposta' }))

    expect(screen.getByRole('textbox', { name: 'Script de pós-resposta' })).toHaveTextContent('al.console.log(1)')
  })

  it('trocar de aba mantém a escolha de pós-resposta e mostra o script da nova aba', () => {
    const panel = (editorKey: string, postResponseScript: string) => (
      <ScriptsPanel
        editorKey={editorKey}
        preRequestScript=""
        postResponseScript={postResponseScript}
        onPreRequestScriptChange={vi.fn()}
        onPostResponseScriptChange={vi.fn()}
        execution={{ status: 'idle' }}
      />
    )
    const { rerender } = render(panel('tab-a', 'aba A'))
    fireEvent.click(screen.getByRole('tab', { name: 'Pós-resposta' }))

    rerender(panel('tab-b', 'aba B'))

    expect(screen.getByRole('tab', { name: 'Pós-resposta' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Script de pós-resposta' })).toHaveTextContent('aba B')
  })

  it('mostra a falha do script de pós-resposta sem perder a resposta', () => {
    renderPanel(successOutput({ scriptError: { phase: 'postResponse', message: 'boom' } }))

    expect(screen.getByText('Erro no script: boom')).toBeInTheDocument()
  })

  it('mostra a falha do script de pré-requisição', () => {
    renderPanel({ status: 'error', error: { kind: 'script', phase: 'preRequest', message: 'sintaxe' } })

    expect(screen.getByText('Erro no script: sintaxe')).toBeInTheDocument()
  })

  it('não mostra saída quando não há erro', () => {
    renderPanel(successOutput({ scriptLogs: ['ignorado aqui'] }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('ScriptsPanel — scripts not trusted (spec 0162)', () => {
  it('locks the editors, says why and offers to trust', () => {
    const onTrust = vi.fn()
    render(
      <ScriptsPanel
        preRequestScript="al.request.url = 'x'"
        postResponseScript=""
        onPreRequestScriptChange={vi.fn()}
        onPostResponseScriptChange={vi.fn()}
        execution={{ status: 'idle' }}
        lock={{ reason: 'collection', onTrust }}
      />,
    )

    expect(screen.getByText('Os scripts desta coleção importada não rodam até você confiar nela.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Script de pré-requisição' })).toHaveAttribute('contenteditable', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Confiar nos scripts' }))
    expect(onTrust).toHaveBeenCalled()
  })

  it('keeps the editors editable without a lock', () => {
    renderPanel()

    expect(screen.queryByText(/não rodam até você confiar/)).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Script de pré-requisição' })).toHaveAttribute('contenteditable', 'true')
  })
})
