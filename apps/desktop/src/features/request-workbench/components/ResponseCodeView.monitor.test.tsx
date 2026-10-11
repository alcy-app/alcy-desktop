import { describe, expect, it, vi } from 'vitest'
import type { ValueMonitorDto } from '../../../bindings/list-value-monitors'
import { render, screen, waitFor } from '../../../test-utils'
import { ResponseCodeView } from './ResponseCodeView'

const evaluateValueMonitors = vi.hoisted(() => vi.fn())
vi.mock('../../../bindings/evaluate-value-monitors', () => ({ evaluateValueMonitors }))

const monitors: ValueMonitorDto[] = [
  { id: 'm1', name: 'Nome curto', enabled: true, fields: ['nome'], rules: [{ id: 'r1', kind: 'lettersOnly' }] },
]

describe('ResponseCodeView com monitor de valores', () => {
  it('envia só os candidatos, destaca o reprovado e reporta a contagem', async () => {
    evaluateValueMonitors.mockResolvedValue({
      ok: true,
      value: [
        { valueIndex: 0, monitorId: 'm1', field: 'nome', failedRuleIds: [] },
        { valueIndex: 1, monitorId: 'm1', field: 'nome', failedRuleIds: ['r1'] },
      ],
    })
    const onFailedCount = vi.fn()
    const { container } = render(
      <ResponseCodeView
        text='{"nome":"Ana","filhos":[{"nome":"Bia 2"}],"idade":3}'
        language="json"
        monitors={monitors}
        onMonitorFailedCount={onFailedCount}
      />,
    )

    await waitFor(() => expect(container.querySelector('.cm-monitor-fail')).not.toBeNull())
    expect(container.querySelector('.cm-monitor-fail')).toHaveTextContent('"Bia 2"')
    expect(container.querySelector('.cm-monitor-pass')).toHaveTextContent('"Ana"')
    expect(evaluateValueMonitors).toHaveBeenCalledWith(monitors, [
      { path: ['nome'], literal: '"Ana"' },
      { path: ['filhos', 0, 'nome'], literal: '"Bia 2"' },
    ])
    expect(onFailedCount).toHaveBeenLastCalledWith(1)
    expect(screen.getByText('1 reprovado')).toBeInTheDocument()
  })

  it('não avalia sem monitores e avisa quando a resposta não é JSON', async () => {
    evaluateValueMonitors.mockClear()
    const { rerender } = render(<ResponseCodeView text='{"nome":"Ana"}' language="json" />)
    expect(screen.queryByRole('status')).toBeNull()

    rerender(<ResponseCodeView text="<nome>Ana</nome>" language="xml" monitors={monitors} />)
    expect(screen.getByRole('status')).toHaveTextContent('O monitor funciona com respostas JSON.')
    expect(evaluateValueMonitors).not.toHaveBeenCalled()
  })
})
