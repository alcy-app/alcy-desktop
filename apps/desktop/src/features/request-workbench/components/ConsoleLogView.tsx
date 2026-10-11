import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { IconButton } from '../../../shared/ui/IconButton'
import { Input } from '../../../shared/ui/Input'
import { CopyIcon, SearchIcon, TerminalIcon, TrashIcon } from '../../../shared/ui/icons'
import { useToast } from '../../../shared/ui/use-toast'
import { matchesFilter, parseFilter } from '../entry-filter'
import type { ConsoleEntry } from '../use-console-state'
import { ConsoleEntryDetailView } from './ConsoleEntryDetail'
import { ERROR_LABEL_KEY, entryLevel, timeColumnStyle, type ConsoleEntryLevel } from './console-entry-presentation'
import { VirtualizedList, type VirtualizedListHandle } from './VirtualizedList'

interface ConsoleLogViewProps {
  entries: ConsoleEntry[]
  onClear: () => void
  onRemove: (id: string) => void
}

type OriginFilter = 'all' | ConsoleEntry['kind']
type LevelFilter = 'all' | ConsoleEntryLevel

const ORIGIN_FILTERS: OriginFilter[] = ['all', 'request', 'script']
const LEVEL_FILTERS: LevelFilter[] = ['all', 'info', 'warning', 'error']

export function ConsoleLogView({ entries, onClear, onRemove }: ConsoleLogViewProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const listRef = useRef<VirtualizedListHandle>(null)
  const previousLengthRef = useRef(0)
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const [level, setLevel] = useState<LevelFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const [newEntries, setNewEntries] = useState(0)

  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      }),
    [language],
  )
  const timeColumn = useMemo(() => timeColumnStyle(timeFormatter), [timeFormatter])

  const filter = useMemo(() => parseFilter(query), [query])
  const visibleEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (origin === 'all' || entry.kind === origin) &&
          (level === 'all' || entryLevel(entry) === level) &&
          (query.trim() === '' || matchesFilter(entry, filter)),
      ),
    [entries, filter, level, origin, query],
  )

  useLayoutEffect(() => {
    const added = Math.max(0, entries.length - previousLengthRef.current)
    previousLengthRef.current = entries.length
    if (added === 0) return
    if (following) listRef.current?.scrollToEnd()
    else setNewEntries((current) => current + added)
  }, [entries.length, following])

  const handleScrollStateChange = useCallback((isAtEnd: boolean) => {
    setFollowing(isAtEnd)
    if (isAtEnd) setNewEntries(0)
  }, [])

  const goToEnd = () => {
    listRef.current?.scrollToEnd()
    setFollowing(true)
    setNewEntries(0)
  }

  const handleCopy = async (entry: ConsoleEntry) => {
    const method = entry.detail?.method.toUpperCase()
    const message =
      entry.kind === 'script'
        ? (entry.scriptMessage ?? '')
        : [method, entry.endpointUrl, entry.statusCode ?? entry.errorKind, entry.durationMs !== null ? `${entry.durationMs} ms` : null]
            .filter(Boolean)
            .join(' · ')
    try {
      await navigator.clipboard.writeText(message)
      showToast(t('devConsole.copySuccess'))
    } catch {
      showToast(t('devConsole.copyError'), 'error')
    }
  }

  const renderEntry = (entry: ConsoleEntry) => {
      const isExpanded = expandedId === entry.id
      const detailId = `console-entry-detail-${entry.id}`
      const currentLevel = entryLevel(entry)
      const status =
        entry.kind === 'script'
          ? t('devConsole.scriptBadge')
          : entry.statusCode !== null
            ? String(entry.statusCode)
            : entry.errorKind
              ? t(ERROR_LABEL_KEY[entry.errorKind])
              : '—'
      return (
        <article className={`console-entry console-entry--${currentLevel}`}>
          <button
            type="button"
            className="console-entry-row"
            aria-expanded={isExpanded}
            aria-controls={detailId}
            aria-label={isExpanded ? t('devConsole.collapseAria') : t('devConsole.expandAria')}
            onClick={() => setExpandedId(isExpanded ? null : entry.id)}
          >
            <span className="console-entry-time">{timeFormatter.format(new Date(entry.executedAtMs))}</span>
            <span className="console-entry-level" aria-label={t(`devConsole.level.${currentLevel}`)} />
            <span className="console-entry-origin">{entry.kind === 'script' ? t('devConsole.scriptBadge') : (entry.detail?.method.toUpperCase() ?? 'HTTP')}</span>
            <span className="console-entry-message">
              {entry.kind === 'script' ? (entry.scriptMessage ?? '') : entry.endpointUrl}
            </span>
            <span className="console-entry-status" title={status}>{status}</span>
            <span className="console-entry-duration">{entry.durationMs !== null ? `${entry.durationMs} ms` : '—'}</span>
          </button>
          <div className="console-entry-actions">
            <IconButton
              icon={<CopyIcon size={12} />}
              label={t('devConsole.copyAria')}
              onClick={() => void handleCopy(entry)}
            />
            <IconButton
              icon={<TrashIcon size={12} />}
              label={t('devConsole.removeAria')}
              variant="danger"
              onClick={() => onRemove(entry.id)}
            />
          </div>
          {isExpanded && (
            <div id={detailId} className="console-entry-detail">
              {entry.kind === 'script' ? (
                <div className="console-entry-detail-content">
                  <p className="console-entry-script-source">{entry.endpointUrl}</p>
                  <pre className={entry.outcome === 'error' ? 'console-entry-script-error' : 'console-entry-script-log'}>
                    {entry.outcome === 'error'
                      ? t('scripts.error', { message: entry.scriptMessage ?? '' })
                      : entry.scriptMessage}
                  </pre>
                </div>
              ) : entry.detail ? (
                <ConsoleEntryDetailView endpointUrl={entry.endpointUrl} statusCode={entry.statusCode} detail={entry.detail} />
              ) : (
                <p className="rw-status-message">{t('devConsole.noDetail')}</p>
              )}
            </div>
          )}
        </article>
      )
    }

  return (
    <section className="console-tool" aria-label={t('devConsole.panelLabel')} style={timeColumn}>
      <div className="console-tool-controls">
        <label className="console-search">
          <SearchIcon size={13} />
          <Input
            type="search"
            mono
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('devConsole.filterPlaceholder')}
            aria-label={t('devConsole.filterAria')}
            title={t('devConsole.filterHelp')}
          />
        </label>
        <div className="console-filter-group" aria-label={t('devConsole.originFilterLabel')}>
          {ORIGIN_FILTERS.map((value) => (
            <button key={value} type="button" aria-pressed={origin === value} onClick={() => setOrigin(value)}>
              {t(`devConsole.origin.${value}`)}
            </button>
          ))}
        </div>
        <div className="console-filter-group" aria-label={t('devConsole.levelFilterLabel')}>
          {LEVEL_FILTERS.map((value) => (
            <button key={value} type="button" aria-pressed={level === value} onClick={() => setLevel(value)}>
              {t(`devConsole.level.${value}`)}
            </button>
          ))}
        </div>
        <span className="console-tool-count">{t('devConsole.visibleCount', { visible: visibleEntries.length, total: entries.length })}</span>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={entries.length === 0}>
          {t('devConsole.clearButton')}
        </Button>
      </div>

      {visibleEntries.length === 0 ? (
        <EmptyState
          icon={<TerminalIcon size={22} />}
          title={entries.length > 0 ? t('devConsole.filterNoMatch') : t('devConsole.emptyState')}
        />
      ) : (
        <div className="console-log-stage">
          <VirtualizedList
            ref={listRef}
            items={visibleEntries}
            getKey={(entry) => entry.id}
            estimatedRowHeight={34}
            renderItem={renderEntry}
            className="console-entry-list"
            ariaLabel={t('devConsole.panelLabel')}
            onScrollStateChange={handleScrollStateChange}
          />
          {!following && (
            <Button className="console-follow-button" size="sm" onClick={goToEnd}>
              {newEntries > 0
                ? t('devConsole.goToEndWithCount', { count: newEntries })
                : t('devConsole.goToEnd')}
            </Button>
          )}
        </div>
      )}
      <p className="console-retention-note">{t('devConsole.retention', { count: 200 })}</p>
    </section>
  )
}
