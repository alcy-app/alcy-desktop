import { useMemo, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { Button } from '../../../shared/ui/Button'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { IconButton } from '../../../shared/ui/IconButton'
import { Input } from '../../../shared/ui/Input'
import { EyeIcon, LockIcon, RecordIcon, SaveIcon, SearchIcon, TrashIcon } from '../../../shared/ui/icons'
import { Tabs } from '../../../shared/ui/Tabs'
import { matchesFilter, parseFilter } from '../entry-filter'
import type { ConsoleEntry } from '../use-console-state'
import { CookiesList } from './CookiesList'
import { ERROR_LABEL_KEY, entryLevel, timeColumnStyle } from './console-entry-presentation'
import { RawExchangeView } from './RawExchangeView'
import { ResponseBody } from './ResponseBody'
import { ResponseHeadersList } from './ResponseHeadersList'
import { ResponseNetworkInfo } from './ResponseNetworkInfo'
import { VirtualizedList } from './VirtualizedList'

export interface HarRecorderControls {
  recording: boolean
  exporting: boolean
  /** Whether the view and the `.har` hide sensitive data (preference in Settings → Security). */
  redactingSensitive: boolean
  entries: ConsoleEntry[]
  onStart: () => void
  onStop: () => void
  onClear: () => void
  onRemove: (id: string) => void
  onSave: () => void
}

interface HarRecorderViewProps {
  recorder: HarRecorderControls
}

type InspectorTab = 'summary' | 'request' | 'response' | 'raw'

const INSPECTOR_TABS: InspectorTab[] = ['summary', 'request', 'response', 'raw']
const entryKey = (entry: ConsoleEntry) => entry.id

export function HarRecorderView({ recorder }: HarRecorderViewProps) {
  const { t, language } = useLanguage()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const filter = useMemo(() => parseFilter(query), [query])
  const visibleEntries = useMemo(
    () => (query.trim() === '' ? recorder.entries : recorder.entries.filter((entry) => matchesFilter(entry, filter))),
    [filter, query, recorder.entries],
  )
  const selectedEntry = recorder.entries.find((entry) => entry.id === selectedId) ?? null
  const failedCount = useMemo(
    () => recorder.entries.filter((entry) => entryLevel(entry) === 'error').length,
    [recorder.entries],
  )
  const averageDuration = useMemo(() => {
    const durations = recorder.entries.flatMap((entry) => (entry.durationMs === null ? [] : [entry.durationMs]))
    if (durations.length === 0) return null
    return Math.round(durations.reduce((total, duration) => total + duration, 0) / durations.length)
  }, [recorder.entries])
  const state = recorder.recording ? 'recording' : recorder.entries.length > 0 ? 'stopped' : 'ready'
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    [language],
  )
  const timeColumn = useMemo(() => timeColumnStyle(timeFormatter), [timeFormatter])


  return (
    <section className="har-tool" aria-label={t('devConsole.recorderPanelLabel')}>
      <div className="har-command-bar">
        <div className={`har-state har-state--${state}`} role="status">
          <span className="har-state-dot" aria-hidden="true" />
          <span>{t(`devConsole.recorderState.${state}`)}</span>
        </div>
        <Button
          variant={recorder.recording ? 'danger' : 'primary'}
          size="sm"
          onClick={recorder.recording ? recorder.onStop : recorder.onStart}
        >
          <RecordIcon size={13} />
          {recorder.recording ? t('devConsole.recorderStop') : t('devConsole.recorderStart')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          isLoading={recorder.exporting}
          onClick={recorder.onSave}
          disabled={recorder.entries.length === 0 || recorder.exporting}
        >
          {!recorder.exporting && <SaveIcon size={13} />}
          {recorder.exporting ? t('devConsole.recorderExporting') : t('devConsole.recorderSave')}
        </Button>
        <span className="har-command-separator" aria-hidden="true" />
        <Metric label={t('devConsole.recorderMetricCaptures')} value={recorder.entries.length} />
        <Metric label={t('devConsole.recorderMetricFailures')} value={failedCount} tone={failedCount > 0 ? 'error' : undefined} />
        <Metric
          label={t('devConsole.recorderMetricAverage')}
          value={averageDuration === null ? '—' : `${averageDuration} ms`}
        />
        <span className="har-command-spacer" />
        {recorder.redactingSensitive ? (
          <Badge className="har-redaction-badge">
            <LockIcon size={11} />
            {t('devConsole.recorderRedacted')}
          </Badge>
        ) : (
          <Badge tone="warning" className="har-redaction-badge">
            <EyeIcon size={11} />
            {t('devConsole.recorderRevealed')}
          </Badge>
        )}
        <Button variant="ghost" size="sm" onClick={recorder.onClear} disabled={recorder.entries.length === 0}>
          {t('devConsole.clearButton')}
        </Button>
      </div>

      <div className="har-filter-bar">
        <label className="console-search">
          <SearchIcon size={13} />
          <Input
            type="search"
            mono
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('devConsole.recorderSearchPlaceholder')}
            aria-label={t('devConsole.filterAria')}
          />
        </label>
        <span>{t('devConsole.visibleCount', { visible: visibleEntries.length, total: recorder.entries.length })}</span>
        <span className="har-retention-note">{t('devConsole.recorderRetention', { count: 500 })}</span>
      </div>

      {recorder.entries.length === 0 ? (
        <EmptyState
          icon={<RecordIcon size={24} />}
          title={recorder.recording ? t('devConsole.recorderEmptyRecording') : t('devConsole.recorderEmptyIdle')}
        />
      ) : (
        <div className="har-workspace">
          <div className="har-table-pane" style={timeColumn}>
            <div className="har-table-header" role="row">
              <span>{t('devConsole.columnTime')}</span>
              <span>{t('devConsole.columnMethod')}</span>
              <span>{t('devConsole.columnUrl')}</span>
              <span>{t('devConsole.columnStatus')}</span>
              <span>{t('devConsole.columnDuration')}</span>
              <span />
            </div>
            {visibleEntries.length === 0 ? (
              <EmptyState icon={<SearchIcon size={22} />} title={t('devConsole.filterNoMatch')} />
            ) : (
              <VirtualizedList
                items={visibleEntries}
                getKey={entryKey}
                estimatedRowHeight={36}
                ariaLabel={t('devConsole.recorderTableLabel')}
                className="har-entry-list"
                renderItem={(entry) => {
                  const level = entryLevel(entry)
                  const status =
                    entry.statusCode !== null
                      ? entry.statusCode
                      : entry.errorKind
                        ? t(ERROR_LABEL_KEY[entry.errorKind])
                        : '—'
                  return (
                    <div className={`har-table-row-wrap har-table-row-wrap--${level}`}>
                      <button
                        type="button"
                        className="har-table-row"
                        aria-pressed={entry.id === selectedId}
                        onClick={() => setSelectedId(entry.id)}
                      >
                        <span>{timeFormatter.format(new Date(entry.executedAtMs))}</span>
                        <span className="har-method">{entry.detail?.method.toUpperCase() ?? 'HTTP'}</span>
                        <span className="har-url" title={entry.endpointUrl}>{entry.endpointUrl}</span>
                        <span className="har-status" title={String(status)}>{status}</span>
                        <span className="har-duration">{entry.durationMs !== null ? `${entry.durationMs} ms` : '—'}</span>
                      </button>
                      <IconButton
                        icon={<TrashIcon size={12} />}
                        label={t('devConsole.removeAria')}
                        variant="danger"
                        onClick={() => recorder.onRemove(entry.id)}
                      />
                    </div>
                  )
                }}
              />
            )}
          </div>
          <HarInspector key={selectedEntry?.id ?? 'empty'} entry={selectedEntry} />
        </div>
      )}
    </section>
  )
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'error' }) {
  return (
    <span className={tone ? `har-metric har-metric--${tone}` : 'har-metric'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  )
}

function HarInspector({ entry }: { entry: ConsoleEntry | null }) {
  const { t } = useLanguage()
  const [tab, setTab] = useState<InspectorTab>('summary')


  if (!entry) {
    return (
      <aside className="har-inspector har-inspector--empty">
        <EmptyState icon={<RecordIcon size={22} />} title={t('devConsole.recorderSelectEntry')} />
      </aside>
    )
  }

  const detail = entry.detail
  return (
    <aside className="har-inspector" aria-label={t('devConsole.recorderInspectorLabel')}>
      <header className="har-inspector-header">
        <div>
          <span className="har-method">{detail?.method.toUpperCase() ?? 'HTTP'}</span>
          <strong>{entry.statusCode ?? (entry.errorKind ? t(ERROR_LABEL_KEY[entry.errorKind]) : '—')}</strong>
        </div>
        <p title={entry.endpointUrl}>{entry.endpointUrl}</p>
      </header>
      <Tabs
        tabs={INSPECTOR_TABS.map((id) => ({ id, label: t(`devConsole.inspector.${id}`) }))}
        activeTab={tab}
        onChange={setTab}
        ariaLabel={t('devConsole.recorderInspectorTabsLabel')}
        idPrefix="har-inspector-"
        variant="compact"
        className="har-inspector-tabs"
      />
      <div
        key={tab}
        id={`tabpanel-har-inspector-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-har-inspector-${tab}`}
        className="har-inspector-content ui-tabpanel-motion"
      >
        {tab === 'summary' && <HarSummary entry={entry} />}
        {tab === 'request' &&
          (detail ? (
            <div className="har-inspector-stack">
              <h4>{t('devConsole.requestHeadersSectionLabel')}</h4>
              <ResponseHeadersList
                headers={detail.requestHeaders}
                emptyMessageKey="response.noRequestHeaders"
                captionKey="response.requestHeadersCaption"
              />
              <h4>{t('devConsole.requestBodyLabel')}</h4>
              {detail.requestBody ? <pre className="har-request-body">{detail.requestBody}</pre> : <p>{t('devConsole.bodyUnavailable')}</p>}
            </div>
          ) : (
            <p className="rw-status-message">{t('devConsole.noDetail')}</p>
          ))}
        {tab === 'response' &&
          (detail ? (
            <div className="har-inspector-stack">
              <h4>{t('devConsole.responseHeadersSectionLabel')}</h4>
              <ResponseHeadersList headers={detail.responseHeaders} />
              <h4>{t('devConsole.cookiesSectionLabel')}</h4>
              <CookiesList cookies={detail.cookies} />
              <h4>{t('devConsole.responseBodySectionLabel')}</h4>
              {(detail.body.kind === 'windowed' || detail.truncated) && <Badge tone="warning">{t('devConsole.previewOnly')}</Badge>}
              <ResponseBody body={detail.body} bodyEncoding={detail.bodyEncoding} headers={detail.responseHeaders} />
            </div>
          ) : (
            <p className="rw-status-message">{t('devConsole.noDetail')}</p>
          ))}
        {tab === 'raw' &&
          (detail ? (
            <RawExchangeView
              method={detail.method}
              url={entry.endpointUrl}
              requestHeaders={detail.requestHeaders}
              requestBody={detail.requestBody}
              statusCode={entry.statusCode ?? 0}
              responseHeaders={detail.responseHeaders}
              responseBody={detail.body}
            />
          ) : (
            <p className="rw-status-message">{t('devConsole.noDetail')}</p>
          ))}
      </div>
    </aside>
  )
}

function HarSummary({ entry }: { entry: ConsoleEntry }) {
  const { t } = useLanguage()
  const detail = entry.detail
  return (
    <div className="har-inspector-stack">
      <dl className="har-summary-grid">
        <div><dt>{t('devConsole.columnStatus')}</dt><dd>{entry.statusCode ?? entry.errorKind ?? '—'}</dd></div>
        <div><dt>{t('devConsole.columnDuration')}</dt><dd>{entry.durationMs !== null ? `${entry.durationMs} ms` : '—'}</dd></div>
        <div><dt>{t('devConsole.columnMethod')}</dt><dd>{detail?.method.toUpperCase() ?? '—'}</dd></div>
        <div><dt>{t('devConsole.httpVersionLabel')}</dt><dd>{detail?.connection.httpVersion || '—'}</dd></div>
      </dl>
      {detail ? (
        <ResponseNetworkInfo
          connection={detail.connection}
          waitingMs={detail.waitingMs}
          durationMs={detail.durationMs}
          finalUrl={detail.finalUrl}
        />
      ) : (
        <p className="rw-status-message">{t('devConsole.noDetail')}</p>
      )}
    </div>
  )
}
