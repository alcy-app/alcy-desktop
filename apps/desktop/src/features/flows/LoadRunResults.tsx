import { useCallback, useEffect, useState } from 'react'
import { getLoadRunSamples } from '../../bindings/get-load-run-history'
import type { LoadRunDetailDto, LoadRunSampleDto } from '../../bindings/get-load-run-history'
import { Button } from '../../shared/ui/Button'
import { useLanguage } from '../../shared/i18n/use-language'
import './load-run-results.css'

interface LoadRunResultsProps {
  rootPath: string
  detail: LoadRunDetailDto
  onClose?: () => void
}

function decimal(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

/** Relatório agregado de carga. As amostras são solicitadas em páginas, sem
 * reter respostas nem carregar uma lista proporcional à execução. */
export function LoadRunResults({ rootPath, detail, onClose }: LoadRunResultsProps) {
  const { t } = useLanguage()
  const [samples, setSamples] = useState<LoadRunSampleDto[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loadingSamples, setLoadingSamples] = useState(true)
  const [samplesError, setSamplesError] = useState(false)

  const loadPage = useCallback((offset: number) => {
    setLoadingSamples(true)
    setSamplesError(false)
    void getLoadRunSamples(rootPath, detail.id, offset).then((result) => {
      setLoadingSamples(false)
      if (!result.ok) {
        setSamplesError(true)
        return
      }
      setSamples((current) => (offset === 0 ? result.value.samples : [...current, ...result.value.samples]))
      setNextOffset(result.value.nextOffset)
    })
  }, [detail.id, rootPath])

  useEffect(() => {
    let current = true
    void getLoadRunSamples(rootPath, detail.id).then((result) => {
      if (!current) return
      setLoadingSamples(false)
      if (!result.ok) {
        setSamplesError(true)
        return
      }
      setSamples(result.value.samples)
      setNextOffset(result.value.nextOffset)
    })
    return () => {
      current = false
    }
  }, [detail.id, rootPath])

  const summary = detail.summary
  return (
    <section className="load-run-results" aria-label={t('flows.loadRun.resultsTitle')}>
      <header className="load-run-results-header">
        <div>
          <h2>{t('flows.loadRun.resultsTitle')}</h2>
          <p>{detail.flowName}</p>
        </div>
        {onClose && <Button variant="ghost" size="sm" onClick={onClose}>{t('flows.loadRun.close')}</Button>}
      </header>

      <p className={`load-run-results-outcome load-run-results-outcome--${detail.passed ? 'passed' : 'failed'}`}>
        {detail.passed ? t('flows.loadRun.passed') : summary.cancelled ? t('flows.loadRun.cancelled') : t('flows.loadRun.failed')}
      </p>

      <dl className="load-run-summary-grid">
        <div><dt>{t('flows.loadRun.requests')}</dt><dd>{summary.requests}</dd></div>
        <div><dt>{t('flows.loadRun.errors')}</dt><dd>{summary.failedRequests}</dd></div>
        <div><dt>{t('flows.loadRun.iterations')}</dt><dd>{summary.completedIterations}</dd></div>
        <div><dt>{t('flows.loadRun.dropped')}</dt><dd>{summary.droppedIterations}</dd></div>
        <div><dt>{t('flows.loadRun.checks')}</dt><dd>{summary.checksPassed}/{summary.checksPassed + summary.checksFailed}</dd></div>
      </dl>

      <h3>{t('flows.loadRun.thresholds')}</h3>
      {detail.thresholds.length === 0 ? <p className="load-run-muted">{t('flows.loadRun.noThresholds')}</p> : (
        <ul className="load-run-thresholds">
          {detail.thresholds.map((threshold, index) => (
            <li key={`${threshold.metric}-${index}`} className={threshold.passed ? 'is-passed' : 'is-failed'}>
              <span>{threshold.metric} {threshold.comparison} {threshold.target}</span>
              <strong>{threshold.passed ? t('flows.loadRun.passed') : t('flows.loadRun.failed')}</strong>
              <small>{t('flows.loadRun.actual')}: {decimal(threshold.actual)}</small>
            </li>
          ))}
        </ul>
      )}

      <h3>{t('flows.loadRun.metrics')}</h3>
      <div className="load-run-table-wrap">
        <table className="load-run-table">
          <thead><tr><th>{t('flows.loadRun.metric')}</th><th>{t('flows.loadRun.count')}</th><th>{t('flows.loadRun.average')}</th><th>{t('flows.loadRun.minimum')}</th><th>{t('flows.loadRun.maximum')}</th><th>{t('flows.loadRun.p90')}</th><th>{t('flows.loadRun.p95')}</th><th>{t('flows.loadRun.p99')}</th></tr></thead>
          <tbody>{detail.metrics.map((metric, index) => (
            <tr key={`${metric.name}-${index}`}><td>{metric.name}</td><td>{metric.count}</td><td>{decimal(metric.average)}</td><td>{decimal(metric.minimum)}</td><td>{decimal(metric.maximum)}</td><td>{decimal(metric.p90)}</td><td>{decimal(metric.p95)}</td><td>{decimal(metric.p99)}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <h3>{t('flows.loadRun.samples')}</h3>
      <p className="load-run-muted">{t('flows.loadRun.samplesSummary', { shown: String(detail.sampleCount), omitted: String(detail.omittedSamples) })}</p>
      {samplesError && <p className="load-run-error">{t('flows.loadRun.samplesError')}</p>}
      <div className="load-run-table-wrap">
        <table className="load-run-table">
          <thead><tr><th>{t('flows.loadRun.scenario')}</th><th>{t('flows.loadRun.vu')}</th><th>{t('flows.loadRun.request')}</th><th>{t('flows.loadRun.status')}</th><th>{t('flows.loadRun.duration')}</th></tr></thead>
          <tbody>{samples.map((sample, index) => (
            <tr key={`${sample.scenarioId}-${sample.vuId}-${index}`} className={sample.failed ? 'is-failed' : undefined}>
              <td>{sample.scenarioId}</td><td>{sample.vuId}</td><td>{sample.method} · {sample.nodeId}</td><td>{sample.status ?? t('flows.loadRun.transportError')}</td><td>{sample.durationMs} {t('flows.loadRun.milliseconds')}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {nextOffset !== null && <Button variant="ghost" onClick={() => loadPage(nextOffset)} disabled={loadingSamples}>{loadingSamples ? t('flows.loadRun.loadingSamples') : t('flows.loadRun.loadMoreSamples')}</Button>}
    </section>
  )
}
