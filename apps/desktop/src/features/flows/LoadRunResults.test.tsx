import type { ReactNode } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLoadRunSamples } from '../../bindings/get-load-run-history'
import type { LoadMetricDto, LoadRunDetailDto, GetLoadRunSamplesResult } from '../../bindings/get-load-run-history'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { ShortcutsProvider } from '../../shared/shortcuts/ShortcutsProvider'
import { ToastProvider } from '../../shared/ui/Toast'
import { LoadRunResults } from './LoadRunResults'
import { FlowCanvas } from './FlowCanvas'
import { createFlow } from './use-flows-state'
import { releaseClosedLoadFlowSessions, useLoadFlowRunSession } from './load-flow-run-session'
import { releaseClosedFlowSessions } from './flow-run-session'

vi.mock('../../bindings/get-load-run-history', () => ({ getLoadRunSamples: vi.fn() }))
vi.mock('../../bindings/mock-servers', () => ({ listMockServers: vi.fn(async () => ({ ok: true, value: { servers: [] } })), getMockServer: vi.fn() }))

function wrapper({ children }: { children: ReactNode }) { return <LanguageProvider><ShortcutsProvider><ToastProvider>{children}</ToastProvider></ShortcutsProvider></LanguageProvider> }

function metric(name: string, kind: string, overrides: Partial<LoadMetricDto> = {}): LoadMetricDto {
  return { name, kind, tags: [], count: 2, value: 40, average: null, minimum: null, maximum: null, p90: null, p95: null, p99: null, ...overrides }
}

const detail: LoadRunDetailDto = {
  id: 'run', flowId: 'flow', flowName: 'Catalog load', startedAtMs: 1000, finishedAtMs: 11000, passed: false,
  summary: { cancelled: false, requests: 120, failedRequests: 30, completedIterations: 57, droppedIterations: 3, checksPassed: 90, checksFailed: 30 },
  metrics: [
    metric('business_events', 'counter'),
    metric('http_req_failed', 'rate', { value: 0.25, count: 120, tags: [['request', 'catalog']] }),
    metric('http_req_duration', 'trend', { value: 80, average: 80, minimum: 40, maximum: 200, p90: 90, p95: 95, p99: 120, tags: [['request', 'catalog']] }),
    metric('http_req_duration', 'trend', { average: 60, tags: [['request', 'checkout']] }),
    metric('checks', 'rate', { count: 120, value: 0.75, tags: [['check', 'status is healthy'], ['scenario', 'catalog']] }),
  ],
  thresholds: [{ metric: 'http_req_duration', statistic: 'p95', comparison: 'lessThan', tags: [['request', 'catalog']], target: 100, actual: 95, passed: true }],
  sampleCount: 2, omittedSamples: 4,
}
const firstSample = { scenarioId: 'catalog', vuId: 1, nodeId: 'first-request', method: 'GET', status: null, failed: true, durationMs: 2 }
const secondSample = { ...firstSample, nodeId: 'second-request', status: 200, failed: false }
const firstPage: GetLoadRunSamplesResult = { ok: true, value: { samples: [firstSample], offset: 0, total: 2, nextOffset: 7 } }

beforeEach(() => {
  localStorage.setItem('alcy:language', 'en')
  vi.mocked(getLoadRunSamples).mockReset().mockResolvedValue(firstPage)
})
afterEach(() => { releaseClosedLoadFlowSessions('/load-results-tests', []); releaseClosedFlowSessions('/load-results-tests', []) })

describe('load run results', () => {
  it('shows throughput, percentages, threshold statistics and named checks', async () => {
    render(<LoadRunResults rootPath="/workspace" detail={detail} />, { wrapper })
    expect(screen.getByText('12 requests/s')).toBeInTheDocument()
    expect(screen.getByText('5.7 iterations/s')).toBeInTheDocument()
    expect(screen.getByText('25.00%')).toBeInTheDocument()
    expect(screen.getByText('75.00% · 30 failed')).toBeInTheDocument()
    const thresholds = screen.getByRole('table', { name: 'Thresholds' })
    expect(thresholds).toHaveTextContent('http_req_duration · p(95) < 100 ms')
    expect(thresholds).toHaveTextContent('request=catalog')
    expect(thresholds).toHaveTextContent('95 ms')
    const checks = screen.getByRole('table', { name: 'Checks' })
    expect(within(checks).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['status is healthyscenario=catalog', '75.00%', '90', '30'])
    await waitFor(() => expect(getLoadRunSamples).toHaveBeenCalledOnce())
  })

  it('distinguishes counter sums from observations and exposes rates, units and series tags', async () => {
    render(<LoadRunResults rootPath="/workspace" detail={detail} />, { wrapper })
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }))
    const table = screen.getByRole('table', { name: 'Metrics' })
    const counter = within(table).getAllByRole('row').find((row) => row.textContent?.includes('business_events'))!
    expect(within(counter).getAllByRole('cell').slice(1, 4).map((cell) => cell.textContent)).toEqual(['2', '40', '4'])
    expect(table).toHaveTextContent('25.00%')
    expect(table).toHaveTextContent('request=catalog')
    expect(table).toHaveTextContent('request=checkout')
    expect(table).toHaveTextContent('95 ms')
    await waitFor(() => expect(getLoadRunSamples).toHaveBeenCalledOnce())
  })

  it('replaces sample pages, retries a failed page and navigates back using server offsets', async () => {
    vi.mocked(getLoadRunSamples)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'notFound' } })
      .mockResolvedValueOnce({ ok: true, value: { samples: [secondSample], offset: 7, total: 2, nextOffset: null } })
    render(<LoadRunResults rootPath="/workspace" detail={detail} />, { wrapper })
    fireEvent.click(screen.getByRole('tab', { name: 'Request samples' }))
    await screen.findByText('first-request')
    expect(screen.getByText('Transport error')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('second-request')
    expect(screen.queryByText('first-request')).not.toBeInTheDocument()
    expect(getLoadRunSamples).toHaveBeenLastCalledWith('/workspace', 'run', 7)
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await screen.findByText('first-request')
    expect(getLoadRunSamples).toHaveBeenLastCalledWith('/workspace', 'run', 0)
    expect(screen.queryByText('second-request')).not.toBeInTheDocument()
  })

  it('keeps cancelled and empty runs explicit without invalid percentages or throughput', async () => {
    const empty = { ...detail, passed: true, finishedAtMs: detail.startedAtMs, metrics: [], thresholds: [], summary: { ...detail.summary, cancelled: true, requests: 0, failedRequests: 0, checksPassed: 0, checksFailed: 0 } }
    render(<LoadRunResults rootPath="/workspace" detail={empty} />, { wrapper })
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument()
    expect(screen.getByText('No thresholds configured.')).toBeInTheDocument()
    expect(screen.getByText('No check results recorded.')).toBeInTheDocument()
    await waitFor(() => expect(getLoadRunSamples).toHaveBeenCalledOnce())
  })

  it('virtualizes large metric sets with table row positions', async () => {
    const metrics = Array.from({ length: 1000 }, (_, index) => metric(`metric_${index}`, 'counter'))
    render(<LoadRunResults rootPath="/workspace" detail={{ ...detail, metrics }} />, { wrapper })
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }))
    const table = screen.getByRole('table', { name: 'Metrics' })
    expect(within(table).getAllByRole('row').length).toBeLessThan(20)
    fireEvent.scroll(within(table).getByRole('rowgroup', { name: 'Metrics' }), { target: { scrollTop: 64 * 995 } })
    expect(within(table).getByText('metric_999').closest('[role="row"]')).toHaveAttribute('aria-rowindex', '1001')
    await waitFor(() => expect(getLoadRunSamples).toHaveBeenCalledOnce())
  })

  it('ignores obsolete sample responses after changing the displayed run', async () => {
    let finish: ((value: GetLoadRunSamplesResult) => void) | undefined
    vi.mocked(getLoadRunSamples).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = render(<LoadRunResults key="old" rootPath="/workspace" detail={detail} />, { wrapper })
    vi.mocked(getLoadRunSamples).mockResolvedValue({ ok: true, value: { samples: [secondSample], offset: 0, total: 1, nextOffset: null } })
    view.rerender(<LoadRunResults key="new" rootPath="/workspace" detail={{ ...detail, id: 'new' }} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Request samples' }))
    await screen.findByText('second-request')
    await act(async () => { finish?.(firstPage) })
    expect(screen.queryByText('first-request')).not.toBeInTheDocument()
  })

  it('hides the canvas and inspector while results are open and restores the selection on close', async () => {
    const flow = createFlow('Load')
    flow.executionKind = 'load'
    flow.nodes.push({ id: 'scenario', kind: 'load', loadKind: 'scenario', label: 'Scenario', config: '{"executor":"constantVus","vus":1,"durationMs":1000}', position: { x: 300, y: 0 } })
    const session = renderHook(() => useLoadFlowRunSession('/load-results-tests', flow.id))
    const view = render(<FlowCanvas rootPath="/load-results-tests" flow={flow} collections={[]} environmentVariables={[]} onChange={vi.fn()} />, { wrapper })
    fireEvent.click(view.container.querySelector('[data-id="scenario"]')!)
    const canvas = view.container.querySelector('.flow-canvas')!
    const inspector = view.container.querySelector('.flow-studio-inspector')!
    expect(inspector).toBeVisible()
    act(() => session.result.current.session.setDetail(detail))
    expect(canvas).not.toBeVisible()
    expect(inspector).not.toBeVisible()
    expect(screen.getByRole('region', { name: 'Load test result' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close result' }))
    expect(canvas).toBeVisible()
    expect(inspector).toBeVisible()
    await act(async () => {})
  })
})
