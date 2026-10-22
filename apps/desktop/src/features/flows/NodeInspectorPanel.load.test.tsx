import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { NodeInspectorPanel } from './NodeInspectorPanel'

function renderLoadInspector(loadKind: 'forEach' | 'select' | 'repeat' | 'timeBox' | 'timer' | 'check' | 'extract' | 'script' | 'group' | 'metric' | 'threshold' | 'request' | 'configureSession' | 'oncePerVu' | 'scenario' | 'dataset', config: string, onLoadConfigChange: (config: string) => void) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
  function StatefulInspector() {
    const [currentConfig, setCurrentConfig] = useState(config)
    return <NodeInspectorPanel
      selection={{ id: 'node', kind: 'load', loadKind, label: 'Control', config: currentConfig }}
      ancestorRequests={[]}
      ancestorLocalVariables={[]}
      environmentVariables={[]}
      collections={[]}
      onLabelChange={() => {}}
      onConditionChange={() => {}}
      onRequestChange={() => {}}
      onConfigChange={() => {}}
      onLoadConfigChange={(_, next) => {
        setCurrentConfig(next)
        onLoadConfigChange(next)
      }}
      onEditInlineRequest={() => {}}
      mockStartOptions={[]}
      selectedMockStart={null}
      savedMockServers={[]}
      onEditInlineMockServer={() => {}}
      onClose={() => {}}
    />
  }
  render(
    <LanguageProvider>
      <StatefulInspector />
    </LanguageProvider>,
  )
}

describe('LoadNodeFields', () => {
  it('preserves required imported variables while editing their values', () => {
    const changes: string[] = []
    renderLoadInspector('configureSession', '{"variables":{"K6_ENV_BASE_URL":""},"requiredVariables":["K6_ENV_BASE_URL"]}', (config) => changes.push(config))
    expect(screen.getByText(/Fill these required variables before running: K6_ENV_BASE_URL/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Session variables'), { target: { value: 'K6_ENV_BASE_URL=https://api.example.test' } })
    expect(JSON.parse(changes[0])).toEqual({ variables: { K6_ENV_BASE_URL: 'https://api.example.test' }, requiredVariables: ['K6_ENV_BASE_URL'] })
    fireEvent.change(screen.getByLabelText('Session variables'), { target: { value: 'renamed=https://api.example.test' } })
    expect(screen.getByText('Fill the required variables: K6_ENV_BASE_URL.')).toBeInTheDocument()
    expect(JSON.parse(changes[1])).toEqual({ variables: { renamed: 'https://api.example.test' }, requiredVariables: ['K6_ENV_BASE_URL'] })
  })

  it('edita a variável e o teto de um ForEach com array JSON', () => {
    const changes: string[] = []
    renderLoadInspector('forEach', '{"variable":"item","itemsVariable":"items","maxItems":2}', (config) => changes.push(config))

    fireEvent.change(screen.getByDisplayValue('items'), { target: { value: 'users' } })
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '5' } })

    expect(JSON.parse(changes[0])).toMatchObject({ itemsVariable: 'users', maxItems: 2 })
    expect(JSON.parse(changes[1])).toMatchObject({ itemsVariable: 'users', maxItems: 5 })
    expect(JSON.parse(changes[1])).not.toHaveProperty('items')
  })

  it('alterna Select de existência para comparação sem expor JSON bruto', () => {
    const changes: string[] = []
    renderLoadInspector('select', '{"variable":"status","operator":"exists"}', (config) => changes.push(config))

    expect(screen.queryByText('JSON configuration')).toBeNull()
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'notEquals' } })

    expect(JSON.parse(changes[0])).toEqual({ variable: 'status', operator: 'notEquals', equals: 'value' })
  })

  it('edita Repeat e TimeBox por campos numéricos', () => {
    const repeatChanges: string[] = []
    renderLoadInspector('repeat', '{"count":2}', (config) => repeatChanges.push(config))
    fireEvent.change(screen.getByLabelText('Iterations'), { target: { value: '4' } })
    expect(JSON.parse(repeatChanges[0])).toEqual({ count: 4 })

    const timeBoxChanges: string[] = []
    renderLoadInspector('timeBox', '{"durationMs":1000}', (config) => timeBoxChanges.push(config))
    fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '250' } })
    expect(JSON.parse(timeBoxChanges[0])).toEqual({ durationMs: 250 })
  })

  it('configura distribuições de Timer, Check, Extract e Script sem JSON bruto', () => {
    const timerChanges: string[] = []
    renderLoadInspector('timer', '{"kind":"fixed","durationMs":1000}', (config) => timerChanges.push(config))
    fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '50' } })
    expect(JSON.parse(timerChanges[0])).toEqual({ kind: 'fixed', durationMs: 50 })
    fireEvent.change(screen.getByLabelText('Timer type'), { target: { value: 'uniform' } })
    expect(JSON.parse(timerChanges[1])).toEqual({ kind: 'uniform', minDurationMs: 500, maxDurationMs: 1000 })
    fireEvent.change(screen.getByLabelText('Minimum duration (ms)'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Maximum duration (ms)'), { target: { value: '40' } })
    expect(JSON.parse(timerChanges[3])).toEqual({ kind: 'uniform', minDurationMs: 20, maxDurationMs: 40 })
    fireEvent.change(screen.getByLabelText('Timer type'), { target: { value: 'gaussian' } })
    expect(JSON.parse(timerChanges[4])).toEqual({ kind: 'gaussian', meanMs: 1000, standardDeviationMs: 100 })
    fireEvent.change(screen.getByLabelText('Timer type'), { target: { value: 'poisson' } })
    expect(JSON.parse(timerChanges[5])).toEqual({ kind: 'poisson', meanMs: 1000 })
    fireEvent.change(screen.getByLabelText('Timer type'), { target: { value: 'pacing' } })
    expect(JSON.parse(timerChanges[6])).toEqual({ kind: 'pacing', periodMs: 1000 })

    const checkChanges: string[] = []
    renderLoadInspector('check', '{"name":"ok","status":200}', (config) => checkChanges.push(config))
    fireEvent.change(screen.getByLabelText('Expected HTTP status'), { target: { value: '201' } })
    expect(JSON.parse(checkChanges[0])).toEqual({ name: 'ok', status: 201 })

    const extractChanges: string[] = []
    renderLoadInspector('extract', '{"name":"user","jsonPointer":""}', (config) => extractChanges.push(config))
    fireEvent.change(screen.getByLabelText('JSON Pointer'), { target: { value: '/id' } })
    expect(JSON.parse(extractChanges[0])).toEqual({ name: 'user', jsonPointer: '/id' })
    fireEvent.change(screen.getByLabelText('Extraction method'), { target: { value: 'regex' } })
    expect(JSON.parse(extractChanges[1])).toEqual({ name: 'user', kind: 'regex', pattern: '(.+)', group: 1 })
    fireEvent.change(screen.getByLabelText('Extraction method'), { target: { value: 'xpath' } })
    expect(JSON.parse(extractChanges[2])).toEqual({ name: 'user', kind: 'xpath', expression: '//value/text()' })
    fireEvent.change(screen.getByLabelText('Extraction method'), { target: { value: 'css' } })
    expect(JSON.parse(extractChanges[3])).toEqual({ name: 'user', kind: 'css', selector: 'body' })
    fireEvent.change(screen.getByLabelText('Attribute'), { target: { value: 'href' } })
    expect(JSON.parse(extractChanges[4])).toEqual({ name: 'user', kind: 'css', selector: 'body', attribute: 'href' })

    const scriptChanges: string[] = []
    renderLoadInspector('script', '{"phase":"preRequest","code":"al.runtime.set(\'id\', \'1\')"}', (config) => scriptChanges.push(config))
    fireEvent.change(screen.getByLabelText('Phase'), { target: { value: 'postResponse' } })
    expect(JSON.parse(scriptChanges[0])).toEqual({ phase: 'postResponse', code: "al.runtime.set('id', '1')" })
  })

  it('configura Group e converte tags chave=valor em mapa', () => {
    const changes: string[] = []
    renderLoadInspector('group', '{"name":"work","tags":{"scope":"api"},"includeTimers":true,"emitParent":true}', (config) => changes.push(config))

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'background' } })
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'scope=jobs\nkind=worker' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Emit the parent duration sample' }))

    expect(JSON.parse(changes[0])).toMatchObject({ name: 'background' })
    expect(JSON.parse(changes[1])).toMatchObject({ tags: { scope: 'jobs', kind: 'worker' } })
    expect(JSON.parse(changes[2])).toMatchObject({ emitParent: false })
  })

  it('configura Metric e Threshold com tags e opções do runtime', () => {
    const metricChanges: string[] = []
    renderLoadInspector('metric', '{"name":"events","kind":"counter","value":1,"tags":{}}', (config) => metricChanges.push(config))
    fireEvent.change(screen.getByLabelText('Metric kind'), { target: { value: 'trend' } })
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'scope=jobs' } })
    expect(JSON.parse(metricChanges[0])).toMatchObject({ kind: 'trend' })
    expect(JSON.parse(metricChanges[1])).toMatchObject({ tags: { scope: 'jobs' } })

    const thresholdChanges: string[] = []
    renderLoadInspector('threshold', '{"metric":"events","tags":{},"statistic":"value","comparison":"gte","target":1}', (config) => thresholdChanges.push(config))
    fireEvent.change(screen.getByLabelText('Statistic'), { target: { value: 'p95' } })
    fireEvent.change(screen.getByLabelText('Comparison'), { target: { value: 'lt' } })
    expect(JSON.parse(thresholdChanges[0])).toMatchObject({ statistic: 'p95' })
    expect(JSON.parse(thresholdChanges[1])).toMatchObject({ comparison: 'lt' })
  })

  it('configura Request com headers, tags e redirects sem JSON bruto', () => {
    const changes: string[] = []
    renderLoadInspector('request', '{"method":"GET","url":"https://api.example.test/health","headers":[],"tags":{}}', (config) => changes.push(config))

    expect(screen.queryByText('JSON configuration')).toBeNull()
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'POST' } })
    fireEvent.change(screen.getByLabelText('Redirects'), { target: { value: 'manual' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }))
    fireEvent.change(screen.getByLabelText('Header name'), { target: { value: 'X-Run' } })
    fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'load' } })

    expect(JSON.parse(changes[0])).toMatchObject({ method: 'POST' })
    expect(JSON.parse(changes[1])).toMatchObject({ redirectPolicy: 'manual' })
    expect(JSON.parse(changes[4])).toMatchObject({ headers: [{ name: 'X-Run', value: 'load', enabled: true }] })
  })

  it('configura a sessão com headers, variáveis e cookies', () => {
    const changes: string[] = []
    renderLoadInspector('configureSession', '{"headers":[],"variables":{},"cookiesEnabled":true}', (config) => changes.push(config))

    fireEvent.click(screen.getByRole('button', { name: 'Add header' }))
    fireEvent.change(screen.getByLabelText('Header name'), { target: { value: 'Accept' } })
    fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'application/json' } })
    fireEvent.change(screen.getByLabelText('Session variables'), { target: { value: 'region=br' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep cookies between requests' }))

    expect(JSON.parse(changes[2])).toMatchObject({ headers: [{ name: 'Accept', value: 'application/json', enabled: true }] })
    expect(JSON.parse(changes[3])).toMatchObject({ variables: { region: 'br' } })
    expect(JSON.parse(changes[4])).toMatchObject({ cookiesEnabled: false })
  })

  it('configura executores, rampas e lifecycle do cenário', () => {
    const changes: string[] = []
    renderLoadInspector('scenario', '{"executor":"sharedIterations","vus":2,"iterations":5}', (config) => changes.push(config))

    expect(screen.queryByText('JSON configuration')).toBeNull()
    fireEvent.change(screen.getByLabelText('Executor'), { target: { value: 'rampingArrivalRate' } })
    fireEvent.change(screen.getByLabelText('Initial rate per time unit'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Stage 1 target'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Phase'), { target: { value: 'setup' } })
    fireEvent.change(screen.getByLabelText('Lifecycle timeout (ms)'), { target: { value: '5000' } })

    expect(JSON.parse(changes[0])).toEqual({ executor: 'rampingArrivalRate', startRate: 1, timeUnitMs: 1000, stages: [{ target: 1, durationMs: 1000 }], preAllocatedVus: 1 })
    expect(JSON.parse(changes[1])).toMatchObject({ startRate: 10 })
    expect(JSON.parse(changes[2])).toMatchObject({ stages: [{ target: 20, durationMs: 1000 }] })
    expect(JSON.parse(changes[3])).toEqual({ phase: 'setup', timeoutMs: 60_000 })
    expect(JSON.parse(changes[4])).toEqual({ phase: 'setup', timeoutMs: 5000 })
  })

  it('edita linhas e colunas de Dataset sem expor JSON bruto', () => {
    const changes: string[] = []
    renderLoadInspector('dataset', '{"rows":[{"user":"ana","region":"br"}],"recycle":true}', (config) => changes.push(config))

    expect(screen.queryByText('JSON configuration')).toBeNull()
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: 'user\nteam' } })
    fireEvent.change(screen.getByLabelText('Row 1, team'), { target: { value: 'platform' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reuse rows when the dataset ends' }))

    expect(JSON.parse(changes[0])).toMatchObject({ rows: [{ user: 'ana', team: '' }] })
    expect(JSON.parse(changes[1])).toMatchObject({ rows: [{ user: 'ana', team: 'platform' }] })
    expect(JSON.parse(changes[2])).toMatchObject({ rows: [{ user: 'ana', team: 'platform' }, { user: '', team: '' }] })
    expect(JSON.parse(changes[3])).toMatchObject({ recycle: false })
  })
})
