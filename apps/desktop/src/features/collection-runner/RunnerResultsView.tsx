import { useEffect, useMemo, useState } from 'react'
import type { FlowNodeOutputDto } from '../../bindings/get-flow-node-output'
import { useLanguage } from '../../shared/i18n/use-language'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Select } from '../../shared/ui/Select'
import { AlertIcon, CheckIcon, CloseIcon, Spinner } from '../../shared/ui/icons'
import { VirtualizedList } from '../request-workbench/components/VirtualizedList'
import { ScriptTestList } from '../request-workbench/components/ScriptTestList'
import { countByFilter, filterOf, filterRows, runRows, stepKey, stepTone, summarizeRun } from './collection-run-state'
import type { CollectionRunState, RunRow, RunSummary, StepFilter } from './collection-run-state'
import { MethodBadge } from './MethodBadge'

/** Busca a resposta guardada de uma requisição (ao vivo ou do histórico). */
export type LoadStepOutput = (step: RunRow) => Promise<FlowNodeOutputDto | null>

interface RunnerResultsViewProps {
  state: CollectionRunState
  loadOutput: LoadStepOutput
  /** Ambiente usado no run, quando conhecido (o histórico não o guarda). */
  environmentName?: string | null
  dataFileName?: string | null
}

const RESULT_ROW_HEIGHT = 48

const FILTERS: StepFilter[] = ['all', 'passed', 'failed', 'skipped']

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} min ${seconds} s`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function RunnerResultsView({ state, loadOutput, environmentName, dataFileName }: RunnerResultsViewProps) {
  const { t } = useLanguage()
  const [filter, setFilter] = useState<StepFilter>('all')
  const [iteration, setIteration] = useState<number | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const summary = summarizeRun(state)
  const rows = useMemo(() => runRows(state), [state])
  const counts = useMemo(() => countByFilter(rows, iteration), [rows, iteration])
  const visible = useMemo(() => filterRows(rows, filter, iteration), [rows, filter, iteration])
  // Sem seleção explícita, acompanha a primeira falha (ou a primeira requisição).
  const selected =
    visible.find((row) => stepKey(row) === selectedKey) ??
    visible.find((row) => filterOf(row.outcome) === 'failed') ??
    visible[0] ??
    null

  return (
    <div className="runner-results">
      <RunSummaryStrip
        state={state}
        summary={summary}
        environmentName={environmentName ?? null}
        dataFileName={dataFileName ?? null}
      />

      <div className="runner-results-toolbar">
        <FilterBar value={filter} counts={counts} onChange={setFilter} />
        {state.iterations > 1 && (
          <Select
            aria-label={t('runner.filter.iteration')}
            className="runner-iteration-select"
            value={iteration === null ? 'all' : String(iteration)}
            onChange={(event) => setIteration(event.target.value === 'all' ? null : Number(event.target.value))}
          >
            <option value="all">{t('runner.filter.allIterations')}</option>
            {Array.from({ length: state.iterations }, (_, index) => (
              <option key={index} value={index}>
                {t('runner.filter.iterationN', { n: String(index + 1) })}
              </option>
            ))}
          </Select>
        )}
      </div>

      <div className="runner-results-split">
        <div className="runner-card runner-results-list-card">
          {visible.length === 0 ? (
            <p className="runner-muted runner-results-empty">
              {state.phase === 'running' && state.steps.length === 0 ? (
                <>
                  <Spinner size={12} /> {t('runner.results.waiting')}
                </>
              ) : (
                t('runner.results.empty')
              )}
            </p>
          ) : (
            <VirtualizedList
              items={visible}
              getKey={stepKey}
              estimatedRowHeight={RESULT_ROW_HEIGHT}
              ariaLabel={t('runner.results.listAria')}
              className="runner-results-list"
              renderItem={(row) => (
                <ResultRow
                  step={row}
                  showIteration={state.iterations > 1}
                  selected={selected !== null && stepKey(selected) === stepKey(row)}
                  onSelect={() => setSelectedKey(stepKey(row))}
                />
              )}
            />
          )}
          {state.current && (
            <div className="runner-results-current" aria-live="polite">
              <Spinner size={12} />
              <span>
                {t('runner.results.runningStep', {
                  position: String(state.current.position + 1),
                  iteration: String(state.current.iteration + 1),
                })}
              </span>
            </div>
          )}
        </div>
        <div className="runner-card runner-detail-card">
          {selected ? (
            <StepDetail
              key={stepKey(selected)}
              step={selected}
              loadOutput={loadOutput}
              showIteration={state.iterations > 1}
            />
          ) : (
            <p className="runner-muted runner-results-empty">{t('runner.detail.select')}</p>
          )}
        </div>
      </div>
    </div>
  )
}

/** "Filtrar por:" com uma opção por resultado e a contagem de cada uma. */
function FilterBar({
  value,
  counts,
  onChange,
}: {
  value: StepFilter
  counts: Record<StepFilter, number>
  onChange: (filter: StepFilter) => void
}) {
  const { t } = useLanguage()
  return (
    <div className="runner-filter">
      <span className="runner-filter-label" aria-hidden="true">
        {t('runner.filter.label')}
      </span>
      <SegmentedControl<StepFilter>
        layout="inline"
        size="sm"
        ariaLabel={t('runner.filter.label')}
        value={value}
        onChange={onChange}
        options={FILTERS.map((option) => ({
          value: option,
          label: t(`runner.filter.${option}`),
          className: `runner-filter-option--${option}`,
          trailing: (
            <span className={`runner-filter-count${counts[option] > 0 ? ' runner-filter-count--nonzero' : ''}`}>
              {counts[option]}
            </span>
          ),
        }))}
      />
    </div>
  )
}

/** Resumo do run numa faixa única: rótulo em cima, valor embaixo. */
function RunSummaryStrip({
  state,
  summary,
  environmentName,
  dataFileName,
}: {
  state: CollectionRunState
  summary: RunSummary
  environmentName: string | null
  dataFileName: string | null
}) {
  const { t } = useLanguage()
  const running = state.phase === 'running'
  const wallMs =
    state.finishedAtMs !== null && state.startedAtMs !== null ? state.finishedAtMs - state.startedAtMs : null
  const items: { label: string; value: string; tone?: 'success' | 'error' | 'warning' }[] = [
    ...(environmentName !== null ? [{ label: t('runner.summary.environment'), value: environmentName }] : []),
    { label: t('runner.summary.iterations'), value: String(state.iterations || 1) },
    ...(dataFileName ? [{ label: t('runner.summary.dataFile'), value: dataFileName }] : []),
    { label: t('runner.summary.requests'), value: `${summary.completed}/${summary.expected}` },
    { label: t('runner.summary.duration'), value: formatDuration(wallMs ?? summary.totalDurationMs) },
    {
      label: t('runner.summary.tests'),
      value: summary.testsTotal === 0 ? '0' : `${summary.testsPassed}/${summary.testsTotal}`,
      tone: summary.testsTotal > 0 && summary.testsPassed < summary.testsTotal ? 'error' : undefined,
    },
    { label: t('runner.summary.failed'), value: String(summary.failed), tone: summary.failed > 0 ? 'error' : undefined },
    { label: t('runner.summary.errors'), value: String(summary.errors), tone: summary.errors > 0 ? 'warning' : undefined },
    {
      label: t('runner.summary.averageTime'),
      value: summary.averageDurationMs === null ? '—' : formatDuration(summary.averageDurationMs),
    },
  ]
  const percent = summary.expected === 0 ? 0 : Math.min(100, (summary.completed / summary.expected) * 100)

  return (
    <div className="runner-summary">
      <dl className="runner-summary-items">
        {items.map((item) => (
          <div key={item.label} className="runner-summary-item">
            <dt>{item.label}</dt>
            <dd className={item.tone ? `runner-summary-value--${item.tone}` : undefined}>{item.value}</dd>
          </div>
        ))}
      </dl>
      {running && (
        <div
          className="runner-summary-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={summary.expected}
          aria-valuenow={summary.completed}
          aria-label={t('runner.results.progressAria')}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  )
}

function OutcomeIcon({ step }: { step: RunRow }) {
  const tone = stepTone(step)
  return (
    <span className={`runner-outcome-icon runner-outcome-icon--${tone}`} aria-hidden="true">
      {step.outcome === 'passed' ? (
        <CheckIcon size={11} />
      ) : step.outcome === 'failed' ? (
        <CloseIcon size={10} />
      ) : step.outcome === 'skipped' || step.outcome === 'cancelled' ? (
        <span className="runner-outcome-skip" />
      ) : (
        <AlertIcon size={11} />
      )}
    </span>
  )
}

function ResultRow({
  step,
  showIteration,
  selected,
  onSelect,
}: {
  step: RunRow
  showIteration: boolean
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useLanguage()
  const passedTests = step.tests.filter((test) => test.passed).length
  return (
    <button
      type="button"
      className={`runner-result-row${selected ? ' runner-result-row--selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <OutcomeIcon step={step} />
      <MethodBadge protocol={step.protocol} method={step.method} />
      <span className="runner-result-main">
        <span className="runner-result-name">{step.name || t('runner.detail.missingRequest')}</span>
        <span className="runner-result-url">
          {step.outcome === 'skipped' ? t('runner.results.notRun') : (step.errorMessage ?? step.resolvedUrl)}
        </span>
      </span>
      <span className="runner-result-meta">
        {showIteration && <span className="runner-chip">{t('runner.results.iterationBadge', { n: String(step.iteration + 1) })}</span>}
        {step.tests.length > 0 && (
          <span className={`runner-chip runner-chip--${passedTests === step.tests.length ? 'success' : 'error'}`}>
            {t('runner.results.testsCount', { passed: String(passedTests), total: String(step.tests.length) })}
          </span>
        )}
        {step.statusCode !== null && (
          <span className={`runner-status runner-status--${step.statusCode >= 400 ? 'error' : 'success'}`}>
            {step.statusCode}
          </span>
        )}
        {step.durationMs !== null && <span className="runner-result-time">{step.durationMs} ms</span>}
      </span>
    </button>
  )
}

type OutputState =
  | { status: 'loading' }
  | { status: 'ready'; output: FlowNodeOutputDto | null }
  | { status: 'error' }

function StepDetail({
  step,
  loadOutput,
  showIteration,
}: {
  step: RunRow
  loadOutput: LoadStepOutput
  showIteration: boolean
}) {
  const { t } = useLanguage()
  const [output, setOutput] = useState<OutputState>(() =>
    step.hasOutput ? { status: 'loading' } : { status: 'ready', output: null },
  )

  useEffect(() => {
    if (!step.hasOutput) return
    let cancelled = false
    loadOutput(step)
      .then((value) => {
        if (!cancelled) setOutput({ status: 'ready', output: value })
      })
      .catch(() => {
        if (!cancelled) setOutput({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [step, loadOutput])

  const method = step.protocol === 'graphql' ? 'GQL' : step.method.toUpperCase()
  const header = (
    <header className="runner-detail-header">
      <h3 className="runner-detail-title">{step.name || t('runner.detail.missingRequest')}</h3>
      <p className="runner-header-details">
        <span className={`runner-status-text runner-status-text--${stepTone(step)}`}>
          <span className="runner-status-dot" aria-hidden="true" />
          {t(`runner.outcome.${step.outcome}`)}
        </span>
        {method && <span className="runner-detail-method">{method}</span>}
        {showIteration && <span>{t('runner.filter.iterationN', { n: String(step.iteration + 1) })}</span>}
      </p>
    </header>
  )
  const passedTests = step.tests.filter((test) => test.passed).length
  const facts: { label: string; value: string; tone?: 'error' }[] = [
    {
      label: t('runner.detail.status'),
      value: step.statusCode === null ? '—' : String(step.statusCode),
      tone: step.statusCode !== null && step.statusCode >= 400 ? 'error' : undefined,
    },
    { label: t('runner.detail.duration'), value: step.durationMs === null ? '—' : `${step.durationMs} ms` },
    { label: t('runner.detail.size'), value: step.sizeBytes === null ? '—' : formatSize(step.sizeBytes) },
    ...(step.tests.length > 0
      ? [
          {
            label: t('runner.detail.tests'),
            value: `${passedTests}/${step.tests.length}`,
            tone: passedTests < step.tests.length ? ('error' as const) : undefined,
          },
        ]
      : []),
  ]

  if (step.outcome === 'skipped') {
    return (
      <div className="runner-detail">
        {header}
        <p className="runner-muted">{t('runner.detail.skipped')}</p>
      </div>
    )
  }

  return (
    <div className="runner-detail">
      {header}

      <dl className="runner-summary runner-summary-items runner-detail-facts">
        {facts.map((fact) => (
          <div key={fact.label} className="runner-summary-item">
            <dt>{fact.label}</dt>
            <dd className={fact.tone ? `runner-summary-value--${fact.tone}` : undefined}>{fact.value}</dd>
          </div>
        ))}
      </dl>

      {step.resolvedUrl && (
        <section className="runner-detail-section">
          <h4>{t('runner.detail.url')}</h4>
          <code className="runner-detail-url">{step.resolvedUrl}</code>
        </section>
      )}

      {step.errorMessage && (
        <section className="runner-detail-section">
          <h4>{t('runner.detail.error')}</h4>
          <p className="runner-detail-error">{step.errorMessage}</p>
        </section>
      )}

      <section className="runner-detail-section">
        <h4>{t('runner.detail.tests')}</h4>
        {step.tests.length === 0 ? (
          <p className="runner-muted">{t('runner.detail.noTests')}</p>
        ) : (
          <ScriptTestList tests={step.tests} />
        )}
      </section>

      {step.logs.length > 0 && (
        <section className="runner-detail-section">
          <h4>{t('runner.detail.logs')}</h4>
          <pre className="runner-detail-pre">{step.logs.join('\n')}</pre>
        </section>
      )}

      <section className="runner-detail-section">
        <h4>{t('runner.detail.response')}</h4>
        <StepOutput state={output} />
      </section>
    </div>
  )
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function StepOutput({ state }: { state: OutputState }) {
  const { t } = useLanguage()
  if (state.status === 'loading') {
    return (
      <p className="runner-muted">
        <Spinner size={11} /> {t('runner.detail.responseLoading')}
      </p>
    )
  }
  if (state.status === 'error' || state.output === null) {
    return <p className="runner-muted">{t('runner.detail.responseUnavailable')}</p>
  }
  const { output } = state
  return (
    <div className="runner-output">
      {output.headers.length > 0 && (
        <details className="runner-output-headers">
          <summary>
            {t('runner.detail.headers')} <span className="runner-count">{output.headers.length}</span>
          </summary>
          <dl>
            {output.headers.map((header, index) => (
              <div key={index}>
                <dt>{header.name}</dt>
                <dd>{header.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {output.bodyEncoding === 'base64' ? (
        <p className="runner-muted">{t('runner.detail.responseBinary', { size: formatSize(output.sizeBytes) })}</p>
      ) : (
        <pre className="runner-detail-pre runner-output-body">{output.body ? prettyBody(output.body) : t('runner.detail.responseEmpty')}</pre>
      )}
      {output.truncated && output.bodyEncoding !== 'base64' && (
        <p className="runner-muted">{t('runner.detail.responseTruncated', { size: formatSize(output.sizeBytes) })}</p>
      )}
    </div>
  )
}
