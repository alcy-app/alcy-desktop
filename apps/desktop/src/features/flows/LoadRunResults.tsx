import { useEffect, useId, useState, type ReactNode } from 'react'
import { getLoadRunSamples } from '../../bindings/get-load-run-history'
import type { LoadRunDetailDto, LoadRunSamplesPageDto } from '../../bindings/get-load-run-history'
import { Badge } from '../../shared/ui/Badge'
import { Button } from '../../shared/ui/Button'
import { Tabs } from '../../shared/ui/Tabs'
import { CheckIcon, CloseIcon, LoadTestIcon } from '../../shared/ui/icons'
import { useLanguage } from '../../shared/i18n/use-language'
import { VirtualizedList } from '../request-workbench/components/VirtualizedList'
import { comparisonSymbol, metricUnit, perSecond, percentage, statisticLabel } from './load-run-format'
import './load-run-results.css'

interface LoadRunResultsProps {
  rootPath: string
  detail: LoadRunDetailDto
  onClose?: () => void
}

type ResultTab = 'overview' | 'metrics' | 'samples'

function Tags({ tags }: { tags: [string, string][] }) {
  return tags.length > 0 && <span className="load-run-tags">{tags.map(([name, value]) => `${name}=${value}`).join(' · ')}</span>
}

function ResultTable<T>({ label, variant, columns, items, renderRow }: {
  label: string
  variant: 'metrics' | 'thresholds' | 'checks' | 'samples'
  columns: string[]
  items: T[]
  renderRow: (item: T) => ReactNode
}) {
  const rows = items.map((item, index) => ({ item, id: String(index) }))
  return (
    <div className={`load-run-table-frame load-run-table-frame--${variant}`}>
      <div className="load-run-data-table" role="table" aria-label={label} aria-colcount={columns.length} aria-rowcount={items.length + 1}>
        <div role="rowgroup"><div className="load-run-data-row load-run-data-heading" role="row" aria-rowindex={1}>{columns.map((column) => <div role="columnheader" key={column}>{column}</div>)}</div></div>
        <VirtualizedList
          role="rowgroup"
          ariaLabel={label}
          className="load-run-data-viewport"
          items={rows}
          estimatedRowHeight={64}
          getKey={(row) => row.id}
          renderItem={({ item }) => <div className="load-run-data-row">{renderRow(item)}</div>}
        />
      </div>
    </div>
  )
}

/** Displays existing native aggregates. Sample navigation retains only one bounded IPC page. */
export function LoadRunResults({ rootPath, detail, onClose }: LoadRunResultsProps) {
  const { t, language } = useLanguage()
  const idPrefix = `${useId()}-load-results-`
  const [activeTab, setActiveTab] = useState<ResultTab>('overview')
  const [page, setPage] = useState<LoadRunSamplesPageDto | null>(null)
  const [pageOffset, setPageOffset] = useState(0)
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([])
  const [retry, setRetry] = useState(0)
  const [loadingSamples, setLoadingSamples] = useState(true)
  const [samplesError, setSamplesError] = useState(false)

  useEffect(() => {
    let current = true
    void getLoadRunSamples(rootPath, detail.id, pageOffset).then((result) => {
      if (!current) return
      setLoadingSamples(false)
      if (!result.ok) {
        setSamplesError(true)
        return
      }
      setPage(result.value)
    })
    return () => { current = false }
  }, [detail.id, rootPath, pageOffset, retry])

  const navigateSamples = (offset: number) => {
    setLoadingSamples(true)
    setSamplesError(false)
    setPageOffset(offset)
  }
  const summary = detail.summary
  const elapsedMs = Math.max(0, detail.finishedAtMs - detail.startedAtMs)
  const checksTotal = summary.checksPassed + summary.checksFailed
  const checks = detail.metrics.filter((metric) => metric.name === 'checks' && metric.kind === 'rate')
  const thresholdsPassed = detail.thresholds.filter((threshold) => threshold.passed).length
  const numberFormat = new Intl.NumberFormat(language, { maximumFractionDigits: 2 })
  const percentFormat = new Intl.NumberFormat(language, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const number = (value: number | null) => value === null ? '—' : numberFormat.format(value)
  const percent = (value: number | null) => value === null ? '—' : percentFormat.format(value)
  const metricNumber = (value: number | null, name: string, statistic: string) => {
    const unit = metricUnit(name, statistic)
    if (value === null) return '—'
    return unit === '%' ? percent(value) : `${number(value)}${unit ? ` ${unit}` : ''}`
  }
  const outcome = summary.cancelled ? 'cancelled' : detail.passed ? 'passed' : 'failed'
  const outcomeLabel = t(outcome === 'cancelled' ? 'flows.loadRun.cancelled' : outcome === 'passed' ? 'flows.loadRun.passed' : 'flows.loadRun.failed')
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' })

  return (
    <section className="load-run-results" aria-label={t('flows.loadRun.resultsTitle')}>
      <header className="load-run-results-header">
        <span className="load-run-results-icon"><LoadTestIcon size={22} /></span>
        <div className="load-run-results-heading"><h2>{t('flows.loadRun.resultsTitle')}</h2><p>{detail.flowName}</p></div>
        <Badge tone={outcome === 'cancelled' ? 'warning' : outcome === 'passed' ? 'success' : 'error'}>{outcomeLabel}</Badge>
        {onClose && <Button variant="ghost" onClick={onClose}><CloseIcon size={12} />{t('flows.loadRun.close')}</Button>}
      </header>

      <div className="load-run-results-body">
        <div className="load-run-timestamps">
          <span>{t('flows.loadRun.started')}: <time dateTime={new Date(detail.startedAtMs).toISOString()}>{dateFormat.format(detail.startedAtMs)}</time></span>
          <span>{t('flows.loadRun.finished')}: <time dateTime={new Date(detail.finishedAtMs).toISOString()}>{dateFormat.format(detail.finishedAtMs)}</time></span>
        </div>
        <dl className="load-run-summary-grid">
          <div><dt>{t('flows.loadRun.duration')}</dt><dd>{number(elapsedMs / 1000)} <small>s</small></dd></div>
          <div><dt>{t('flows.loadRun.requests')}</dt><dd>{number(summary.requests)}</dd><small>{number(perSecond(summary.requests, elapsedMs))} {t('flows.loadRun.requestsPerSecond')}</small></div>
          <div className={summary.failedRequests > 0 ? 'load-run-summary-failed' : undefined}><dt>{t('flows.loadRun.errors')}</dt><dd>{number(summary.failedRequests)}</dd><small>{percent(percentage(summary.failedRequests, summary.requests))}</small></div>
          <div><dt>{t('flows.loadRun.iterations')}</dt><dd>{number(summary.completedIterations)}</dd><small>{number(perSecond(summary.completedIterations, elapsedMs))} {t('flows.loadRun.iterationsPerSecond')}</small></div>
          <div><dt>{t('flows.loadRun.dropped')}</dt><dd>{number(summary.droppedIterations)}</dd></div>
          <div><dt>{t('flows.loadRun.checks')}</dt><dd>{number(summary.checksPassed)}<small> / {number(checksTotal)}</small></dd><small>{percent(percentage(summary.checksPassed, checksTotal))} · {t('flows.loadRun.failedChecks', { count: summary.checksFailed })}</small></div>
        </dl>

        <Tabs<ResultTab> tabs={[{ id: 'overview', label: t('flows.loadRun.overview') }, { id: 'metrics', label: t('flows.loadRun.metrics'), badge: detail.metrics.length }, { id: 'samples', label: t('flows.loadRun.samples'), badge: detail.sampleCount }]} activeTab={activeTab} onChange={setActiveTab} ariaLabel={t('flows.loadRun.resultsTitle')} idPrefix={idPrefix} />
        <div role="tabpanel" id={`tabpanel-${idPrefix}${activeTab}`} aria-labelledby={`tab-${idPrefix}${activeTab}`} className="load-run-tab-panel">
          {activeTab === 'overview' && <>
            <section className="load-run-result-section" aria-label={t('flows.loadRun.thresholds')}>
              <div className="load-run-section-heading"><h3>{t('flows.loadRun.thresholds')}</h3><Badge tone={thresholdsPassed < detail.thresholds.length ? 'error' : 'neutral'}>{thresholdsPassed} / {detail.thresholds.length}</Badge></div>
              {detail.thresholds.length === 0 ? <p className="load-run-muted">{t('flows.loadRun.noThresholds')}</p> : <ResultTable
                label={t('flows.loadRun.thresholds')}
                variant="thresholds"
                columns={[t('flows.loadRun.condition'), t('flows.loadRun.actual'), t('flows.loadRun.status')]}
                items={detail.thresholds}
                renderRow={(threshold) => <>
                  <div role="cell" className="load-run-series"><code>{threshold.metric} · {statisticLabel(threshold.statistic)} {comparisonSymbol(threshold.comparison)} {metricNumber(threshold.target, threshold.metric, threshold.statistic)}</code><Tags tags={threshold.tags} /></div>
                  <div role="cell">{metricNumber(threshold.actual, threshold.metric, threshold.statistic)}</div>
                  <div role="cell"><Badge tone={threshold.passed ? 'success' : 'error'}>{threshold.passed ? <CheckIcon size={12} /> : <CloseIcon size={12} />}{threshold.passed ? t('flows.loadRun.passed') : t('flows.loadRun.failed')}</Badge></div>
                </>}
              />}
            </section>
            <section className="load-run-result-section" aria-label={t('flows.loadRun.checks')}>
              <h3>{t('flows.loadRun.checks')}</h3>
              {checks.length === 0 ? <p className="load-run-muted">{t('flows.loadRun.noChecks')}</p> : <ResultTable
                label={t('flows.loadRun.checks')}
                variant="checks"
                columns={[t('flows.loadRun.checkName'), t('flows.loadRun.successRate'), t('flows.loadRun.passed'), t('flows.loadRun.failed')]}
                items={checks}
                renderRow={(metric) => <>
                  <div role="cell" className="load-run-series"><strong>{metric.tags.find(([name]) => name === 'check')?.[1] ?? metric.name}</strong><Tags tags={metric.tags.filter(([name]) => name !== 'check')} /></div>
                  <div role="cell"><Badge tone={metric.value === 1 ? 'success' : 'error'}>{percent(metric.value)}</Badge></div>
                  <div role="cell">{number(Math.round(metric.value * metric.count))}</div>
                  <div role="cell">{number(metric.count - Math.round(metric.value * metric.count))}</div>
                </>}
              />}
            </section>
            <details className="load-run-coverage"><summary>{t('flows.loadRun.coverageTitle')}</summary><p>{t('flows.loadRun.coverageDescription')}</p></details>
          </>}

          {activeTab === 'metrics' && <section className="load-run-result-section">
            <p className="load-run-muted">{t('flows.loadRun.metricsHint')}</p>
            {detail.metrics.length === 0 ? <p className="load-run-muted">{t('flows.loadRun.noMetrics')}</p> : <ResultTable
              label={t('flows.loadRun.metrics')}
              variant="metrics"
              columns={[t('flows.loadRun.metric'), t('flows.loadRun.count'), t('flows.loadRun.value'), t('flows.loadRun.perSecond'), t('flows.loadRun.average'), t('flows.loadRun.minimum'), t('flows.loadRun.maximum'), t('flows.loadRun.p90'), t('flows.loadRun.p95'), t('flows.loadRun.p99')]}
              items={detail.metrics}
              renderRow={(metric) => <>
                <div role="cell" className="load-run-series"><strong>{metric.name}</strong><span className="load-run-metric-kind">{metric.kind}</span><Tags tags={metric.tags} /></div>
                <div role="cell">{number(metric.count)}</div>
                <div role="cell">{metric.kind === 'trend' ? '—' : metricNumber(metric.value, metric.name, metric.kind === 'rate' ? 'rate' : 'value')}</div>
                <div role="cell">{metric.kind === 'counter' ? number(perSecond(metric.value, elapsedMs)) : '—'}</div>
                {[metric.average, metric.minimum, metric.maximum, metric.p90, metric.p95, metric.p99].map((value, index) => <div role="cell" key={index}>{metricNumber(value, metric.name, 'value')}</div>)}
              </>}
            />}
          </section>}

          {activeTab === 'samples' && <section className="load-run-result-section" aria-busy={loadingSamples}>
            <p className="load-run-muted">{t('flows.loadRun.samplesSummary', { shown: detail.sampleCount, omitted: detail.omittedSamples })}</p>
            {loadingSamples ? <p role="status" className="load-run-muted">{t('flows.loadRun.loadingSamples')}</p> : samplesError ? <div className="load-run-samples-error"><p className="load-run-error" role="alert">{t('flows.loadRun.samplesError')}</p><Button variant="ghost" onClick={() => { setLoadingSamples(true); setSamplesError(false); setRetry((value) => value + 1) }}>{t('common.retry')}</Button></div> : page && page.samples.length > 0 ? <>
              <ResultTable
                label={t('flows.loadRun.samples')}
                variant="samples"
                columns={[t('flows.loadRun.scenario'), t('flows.loadRun.vu'), t('flows.loadRun.request'), t('flows.loadRun.status'), t('flows.loadRun.duration')]}
                items={page.samples}
                renderRow={(sample) => <>
                  <div role="cell"><code>{sample.scenarioId}</code></div><div role="cell">{sample.vuId}</div>
                  <div role="cell" className="load-run-series"><strong>{sample.method}</strong><code>{sample.nodeId}</code></div>
                  <div role="cell"><Badge tone={sample.failed ? 'error' : 'success'}>{sample.status ?? t('flows.loadRun.transportError')}</Badge></div>
                  <div role="cell">{number(sample.durationMs)} ms</div>
                </>}
              />
              <div className="load-run-samples-pagination">
                <span className="load-run-muted">{t('flows.loadRun.samplesRange', { from: page.offset + 1, to: page.offset + page.samples.length, total: page.total })}</span>
                <Button variant="ghost" disabled={previousOffsets.length === 0} onClick={() => { const previous = previousOffsets.at(-1); if (previous !== undefined) { setPreviousOffsets((offsets) => offsets.slice(0, -1)); navigateSamples(previous) } }}>{t('flows.loadRun.previousPage')}</Button>
                <Button variant="ghost" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) { setPreviousOffsets((offsets) => [...offsets, pageOffset]); navigateSamples(page.nextOffset) } }}>{t('flows.loadRun.nextPage')}</Button>
              </div>
            </> : <p className="load-run-muted">{t('flows.loadRun.noSamples')}</p>}
          </section>}
        </div>
      </div>
    </section>
  )
}
