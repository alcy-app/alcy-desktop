import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '../../../test-utils'
import type { ConnectionInfo, ScriptTestResult } from '../../../bindings/execute-graphql-request'
import type { ExecutionState } from '../request-workbench.types'
import { ResponsePanel } from './ResponsePanel'

function success(testResults: ScriptTestResult[]): ExecutionState {
  return {
    status: 'success',
    result: {
      statusCode: 200,
      durationMs: 5,
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
      testResults,
    },
  }
}

function renderPanel(execution: ExecutionState) {
  render(<ResponsePanel execution={execution} onClear={() => {}} layout="bottom" onToggleLayout={() => {}} />)
}

describe('ResponsePanel — testes de script', () => {
  it('não mostra a aba Tests sem testes registrados', () => {
    renderPanel(success([]))

    expect(screen.queryByRole('tab', { name: /Tests/ })).not.toBeInTheDocument()
  })

  it('mostra a contagem e a mensagem de cada teste que falhou', () => {
    renderPanel(
      success([
        { name: 'status 200', passed: true, message: null },
        { name: 'tem id', passed: false, message: 'esperado ter a propriedade "id"' },
      ]),
    )

    const tab = screen.getByRole('tab', { name: /Tests/ })
    expect(tab).toHaveTextContent('1/2')
    fireEvent.click(tab)

    expect(screen.getByText('status 200')).toBeInTheDocument()
    expect(screen.getByText('esperado ter a propriedade "id"')).toBeInTheDocument()
  })
})

describe('ResponsePanel — globo de conexão', () => {
  function withConnection(connection: ConnectionInfo): ExecutionState {
    const state = success([])
    if (state.status !== 'success') throw new Error('estado inesperado')
    return { ...state, result: { ...state.result, connection } }
  }

  it('não mostra o globo quando a resposta não tem dados de conexão', () => {
    renderPanel(success([]))

    expect(screen.queryByRole('button', { name: /Detalhes da conexão/ })).not.toBeInTheDocument()
  })

  it('mostra os dados da conexão no hover, sem aviso com a verificação ativa', () => {
    renderPanel(withConnection({ remoteAddress: '10.0.0.1:443', httpVersion: 'HTTP/2', tlsCertificatePresent: true, certificateVerificationDisabled: false }))

    const badge = screen.getByRole('button', { name: 'Detalhes da conexão' })
    expect(badge).not.toHaveClass('rw-network-badge--warning')
    fireEvent.mouseEnter(badge)

    const card = screen.getByRole('tooltip')
    expect(card).toHaveTextContent('10.0.0.1:443')
    expect(card).toHaveTextContent('HTTP/2')
    expect(card).toHaveTextContent('Ativa')
    expect(card).not.toHaveTextContent('Verificação de certificado SSL desativada')

    fireEvent.mouseLeave(badge)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('destaca o globo e avisa quando o certificado não foi verificado', () => {
    renderPanel(withConnection({ remoteAddress: '10.0.0.1:443', httpVersion: 'HTTP/1.1', tlsCertificatePresent: true, certificateVerificationDisabled: true }))

    const badge = screen.getByRole('button', { name: /Verificação de certificado SSL desativada/ })
    expect(badge).toHaveClass('rw-network-badge--warning')
    fireEvent.focus(badge)

    expect(screen.getByRole('tooltip')).toHaveTextContent('Verificação de certificado SSL desativada')
  })
})

describe('ResponsePanel — resposta acima do limite', () => {
  const tooLarge: ExecutionState = {
    status: 'error',
    error: { kind: 'responseTooLarge', limitBytes: 50 * 1024 * 1024, receivedBytes: 120 * 1024 * 1024 },
  }

  it('explica o limite e reenvia sem limite pelo botão', () => {
    const resends: number[] = []
    render(
      <ResponsePanel
        execution={tooLarge}
        onClear={() => {}}
        layout="bottom"
        onToggleLayout={() => {}}
        onResendWithoutLimit={() => resends.push(1)}
      />,
    )

    expect(screen.getByText(/A resposta \(120 MB\) passou do limite de 50 MB/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar sem limite' }))

    expect(resends).toHaveLength(1)
  })

  it('não oferece o reenvio para outras falhas', () => {
    render(
      <ResponsePanel
        execution={{ status: 'error', error: { kind: 'timeout' } }}
        onClear={() => {}}
        layout="bottom"
        onToggleLayout={() => {}}
        onResendWithoutLimit={() => {}}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Reenviar sem limite' })).not.toBeInTheDocument()
  })
})

describe('ResponsePanel — tempo decorrido do envio', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('conta ao vivo a partir do início do envio enquanto a requisição está em andamento', () => {
    renderPanel({ status: 'loading', startedAt: 8_500 })

    const timer = screen.getByRole('timer', { name: 'Tempo decorrido desde o envio' })
    expect(timer).toHaveTextContent('1.5 s')

    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(timer).toHaveTextContent('2.5 s')
  })

  it('troca o contador pelo tempo final quando a resposta chega', () => {
    renderPanel(success([]))

    expect(screen.queryByRole('timer')).not.toBeInTheDocument()
    expect(screen.getByText('5 ms')).toBeInTheDocument()
  })
})
