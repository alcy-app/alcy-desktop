import { useEffect, useMemo, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { MenuItem, OptionsMenu } from '../../../shared/ui/Menu'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import { ClockIcon, FilterIcon, FlowIcon, FolderIcon, RunnerIcon } from '../../../shared/ui/icons'
import { filterHistory, groupHistoryByDate } from '../history'
import type { ActiveComponentKind, HistoryFilter } from '../history'
import type { HistoryEntrySummaryDto } from '../../../bindings/list-history'
import './history-panel.css'

interface HistoryPanelProps {
  entries: HistoryEntrySummaryDto[]
  loaded: boolean
  activeComponentKind: ActiveComponentKind
  onRestore: (id: string) => void
  onRefresh: () => void
}

type Translate = ReturnType<typeof useLanguage>['t']

interface EntryPresentation {
  name: string
  statusText: string
  isError: boolean
  ariaLabel: string
}

function presentEntry(entry: HistoryEntrySummaryDto, t: Translate): EntryPresentation {
  if (entry.origin === 'flow') {
    return {
      name: entry.flowName,
      statusText: t(`history.flowStatus.${entry.status}`),
      isError: entry.status === 'failed',
      ariaLabel: t('history.openRunLogAria', { name: entry.flowName }),
    }
  }
  if (entry.origin === 'runner') {
    return {
      name: entry.scopeName,
      statusText:
        entry.status === 'cancelled'
          ? t('history.flowStatus.cancelled')
          : t('history.runnerStatus', { passed: String(entry.passed), total: String(entry.total) }),
      isError: entry.status === 'failed',
      ariaLabel: t('history.openRunnerReportAria', { name: entry.scopeName }),
    }
  }
  if (entry.origin === 'load') {
    return {
      name: entry.flowName,
      statusText:
        entry.status === 'cancelled'
          ? t('history.flowStatus.cancelled')
          : t('history.loadStatus', { requests: String(entry.requests), errors: String(entry.failedRequests) }),
      isError: entry.status === 'failed' || !entry.passed,
      ariaLabel: t('history.openLoadReportAria', { name: entry.flowName }),
    }
  }

  const { outcome } = entry
  const statusText =
    outcome.type === 'success'
      ? `${outcome.statusCode}`
      : outcome.kind === 'network'
        ? t('history.failureNetwork')
        : t('history.failureTimeout')
  return {
    name: entry.endpoint,
    statusText,
    isError: outcome.type === 'failed',
    ariaLabel: t('history.restoreAria', { name: entry.endpoint }),
  }
}

export function HistoryPanel({ entries, loaded, activeComponentKind, onRestore, onRefresh }: HistoryPanelProps) {
  const { t, language } = useLanguage()
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const filterOptions: { value: HistoryFilter; label: string }[] = [
    { value: 'all', label: t('history.filter.all') },
    { value: 'current', label: t('history.filter.current') },
    { value: 'collections', label: t('history.filter.collections') },
    { value: 'flows', label: t('history.filter.flows') },
    { value: 'runners', label: t('history.filter.runners') },
  ]
  const filtered = useMemo(
    () => filterHistory(entries, filter, activeComponentKind),
    [entries, filter, activeComponentKind],
  )
  const groups = useMemo(() => groupHistoryByDate(filtered), [filtered])

  // Runs de flow e do runner gravam entradas sem passar pelo workbench: recarrega ao abrir a aba.
  useEffect(() => {
    onRefresh()
  }, [onRefresh])

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(language, { day: '2-digit', month: 'long', year: 'numeric' }),
    [language],
  )
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }), [language])

  // The shell lays this module out as a pinned toolbar over a scrolling body
  // (`.sidebar-panel-layout`), so even the toolbar-less empty state sits in the body.
  if (loaded && entries.length === 0) {
    return (
      <div className="history-panel sidebar-panel-layout">
        <div className="sidebar-panel-scroll">
          <EmptyState icon={<ClockIcon size={22} />} title={t('history.emptyState')} />
        </div>
      </div>
    )
  }

  return (
    <div className="history-panel sidebar-panel-layout">
      <div className="history-toolbar sidebar-panel-toolbar">
        <OptionsMenu
          label={t('history.filter.label')}
          icon={<FilterIcon size={14} />}
          isOpen={filterMenuOpen}
          onToggle={() => setFilterMenuOpen((open) => !open)}
          onClose={() => setFilterMenuOpen(false)}
          wrapperClassName="history-filter-host"
          menuClassName="history-filter-menu"
        >
          {filterOptions.map((option) => (
            <MenuItem
              key={option.value}
              label={option.label}
              selected={filter === option.value}
              onSelect={() => {
                setFilter(option.value)
                setFilterMenuOpen(false)
              }}
            />
          ))}
        </OptionsMenu>
      </div>
      <div className="sidebar-panel-scroll">
        {loaded && filtered.length === 0 && (
          <EmptyState icon={<ClockIcon size={22} />} title={t('history.emptyFiltered')} />
        )}
        <ul className="history-list" aria-label={t('environments.historyTab')}>
          {groups.map((group) => (
            <li key={group.dateKey} className="history-group">
              <h3 className="history-date-heading">{dateFormatter.format(new Date(group.entries[0].executedAtMs))}</h3>
              <ul className="history-entries">
                {group.entries.map((entry) => (
                  <HistoryEntryItem key={entry.id} entry={entry} timeFormatter={timeFormatter} onRestore={onRestore} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

interface HistoryEntryItemProps {
  entry: HistoryEntrySummaryDto
  timeFormatter: Intl.DateTimeFormat
  onRestore: (id: string) => void
}

function HistoryEntryItem({ entry, timeFormatter, onRestore }: HistoryEntryItemProps) {
  const { t } = useLanguage()
  const { name, statusText, isError, ariaLabel } = presentEntry(entry, t)
  const originLabel = t(`history.origin.${entry.origin}`)
  const originTooltip = useTooltip(originLabel)
  // A URL costuma ser cortada com reticências na largura do painel.
  const urlTooltip = useTooltip(name, { multiline: true, enabled: entry.origin === 'collection' })

  return (
    <li>
      <button type="button" className="history-entry-button" onClick={() => onRestore(entry.id)} aria-label={ariaLabel}>
        <span className="history-origin-icon" role="img" aria-label={originLabel} {...originTooltip.triggerProps}>
          {entry.origin === 'flow' ? (
            <FlowIcon size={13} />
          ) : entry.origin === 'runner' || entry.origin === 'load' ? (
            <RunnerIcon size={13} />
          ) : (
            <FolderIcon size={13} />
          )}
        </span>
        {originTooltip.tooltip}
        <Badge tone={isError ? 'error' : 'accent'} className="history-status-badge">
          {statusText}
        </Badge>
        <span className="history-entry-name" {...urlTooltip.triggerProps}>
          {name}
        </span>
        {urlTooltip.tooltip}
        <span className="history-entry-time">{timeFormatter.format(new Date(entry.executedAtMs))}</span>
      </button>
    </li>
  )
}
