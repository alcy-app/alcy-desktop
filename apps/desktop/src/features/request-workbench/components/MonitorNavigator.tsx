import { useMemo, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { IconButton } from '../../../shared/ui/IconButton'
import { OptionsMenu } from '../../../shared/ui/Menu'
import { AlertIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../../../shared/ui/icons'
import { Tooltip } from '../../../shared/ui/Tooltip'
import { MAX_MONITOR_CANDIDATES } from '../value-monitor-candidates'
import type { MonitorFindings, MonitorHighlight } from '../use-value-monitor-findings'

const ALL_FIELDS = ''

interface MonitorNavigatorProps {
  findings: MonitorFindings
  /** Seleciona e rola até a ocorrência no editor. */
  onReveal: (highlight: MonitorHighlight) => void
}

/** Se a ocorrência reprovou em algum monitor — considerando só o campo filtrado, quando há filtro. */
function failedFor(highlight: MonitorHighlight, field: string): boolean {
  return highlight.results.some((result) => (field === ALL_FIELDS || result.field === field) && result.failedRuleIds.length > 0)
}

/** Quantas ocorrências do campo a navegação percorreria — só reprovadas, a menos que `includePassed`. */
function countFor(highlights: MonitorHighlight[], field: string, includePassed: boolean): number {
  return highlights.filter(
    (highlight) =>
      (field === ALL_FIELDS || highlight.results.some((result) => result.field === field)) &&
      (includePassed || failedFor(highlight, field)),
  ).length
}

interface FieldOptionProps {
  label: string
  count: number
  selected: boolean
  mono?: boolean
  autoFocus?: boolean
  onSelect: () => void
}

/** Opção do menu de campo: marcação à esquerda, nome e a contagem alinhada à direita. */
function FieldOption({ label, count, selected, mono, autoFocus, onSelect }: FieldOptionProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className="ui-menu-item rw-monitor-option"
      autoFocus={autoFocus}
      onClick={onSelect}
    >
      <span className="rw-monitor-option-mark" aria-hidden="true">
        {selected && <CheckIcon size={12} />}
      </span>
      <span className={`rw-monitor-option-label${mono ? ' rw-monitor-option-label--mono' : ''}`}>{label}</span>
      <span className="rw-monitor-option-count" aria-hidden="true">
        {count}
      </span>
    </button>
  )
}

/**
 * Pílula compacta sobre o canto do editor: filtro por campo, contagem e
 * anterior/próxima. Por padrão percorre só os valores reprovados;
 * "Incluir aprovados" fica dentro do menu do campo.
 */
export function MonitorNavigator({ findings, onReveal }: MonitorNavigatorProps) {
  const { t } = useLanguage()
  const [field, setField] = useState(ALL_FIELDS)
  const [includePassed, setIncludePassed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [position, setPosition] = useState<{ key: MonitorFindings; index: number } | null>(null)

  const highlights = useMemo(() => (findings.status === 'ready' ? findings.highlights : []), [findings])
  const fields = useMemo(
    () => [...new Set(highlights.flatMap((highlight) => highlight.results.map((result) => result.field)))],
    [highlights],
  )
  // Um campo que sumiu da resposta (outra requisição) volta a "Todos os campos".
  const activeField = fields.includes(field) ? field : ALL_FIELDS
  const inField = useMemo(
    () =>
      activeField === ALL_FIELDS
        ? highlights
        : highlights.filter((highlight) => highlight.results.some((result) => result.field === activeField)),
    [highlights, activeField],
  )
  const occurrences = useMemo(
    () => (includePassed ? inField : inField.filter((highlight) => failedFor(highlight, activeField))),
    [inField, includePassed, activeField],
  )
  // A posição só vale para o resultado em que foi escolhida.
  const index = position?.key === findings && position.index < occurrences.length ? position.index : null

  if (findings.status !== 'ready' || findings.highlights.length === 0) {
    const message =
      findings.status === 'notJson'
        ? t('monitor.notJson')
        : findings.status === 'partial'
          ? t('monitor.partial')
          : findings.status === 'evaluating'
            ? t('monitor.evaluating')
            : findings.status === 'error'
              ? t('monitor.error')
              : t('monitor.noMatches')
    return (
      <div className="rw-monitor-pill" role="status">
        <span className="rw-monitor-pill-text">{message}</span>
      </div>
    )
  }

  const go = (step: 1 | -1) => {
    if (occurrences.length === 0) return
    const next = index === null ? (step === 1 ? 0 : occurrences.length - 1) : (index + step + occurrences.length) % occurrences.length
    setPosition({ key: findings, index: next })
    onReveal(occurrences[next])
  }

  const count = (key: 'monitor.failedCount' | 'monitor.occurrenceCount', total: number) =>
    t(total === 1 ? (`${key}One` as const) : key, { count: total })
  const allPassed = !includePassed && occurrences.length === 0
  const summary = allPassed
    ? t(inField.length === 1 ? 'monitor.allPassedOne' : 'monitor.allPassed', { count: inField.length })
    : index !== null
      ? t('monitor.position', { current: index + 1, total: occurrences.length })
      : count(includePassed ? 'monitor.occurrenceCount' : 'monitor.failedCount', occurrences.length)

  return (
    <div
      className="rw-monitor-pill"
      role="group"
      aria-label={t('monitor.navigatorAria')}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault()
          go(event.shiftKey ? -1 : 1)
        }
      }}
      tabIndex={0}
    >
      <OptionsMenu
        label={t('monitor.fieldMenuAria')}
        isOpen={menuOpen}
        onToggle={() => setMenuOpen((open) => !open)}
        onClose={() => setMenuOpen(false)}
        buttonClassName="rw-monitor-field-trigger"
        menuClassName="rw-monitor-field-menu"
        icon={
          <>
            <span className={`rw-monitor-field-label${activeField === ALL_FIELDS ? '' : ' rw-monitor-field-label--mono'}`}>
              {activeField === ALL_FIELDS ? t('monitor.allFields') : activeField}
            </span>
            <ChevronDownIcon size={11} />
          </>
        }
      >
        <span className="rw-monitor-menu-heading" aria-hidden="true">
          {t('monitor.fieldHeading')}
        </span>
        <FieldOption
          label={t('monitor.allFields')}
          count={countFor(highlights, ALL_FIELDS, includePassed)}
          selected={activeField === ALL_FIELDS}
          autoFocus
          onSelect={() => {
            setField(ALL_FIELDS)
            setMenuOpen(false)
          }}
        />
        {fields.map((name) => (
          <FieldOption
            key={name}
            label={name}
            mono
            count={countFor(highlights, name, includePassed)}
            selected={activeField === name}
            onSelect={() => {
              setField(name)
              setMenuOpen(false)
            }}
          />
        ))}
        <div className="rw-monitor-menu-separator" role="separator" />
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={includePassed}
          className="ui-menu-item rw-monitor-option"
          onClick={() => setIncludePassed((current) => !current)}
        >
          <span className="rw-monitor-option-mark" aria-hidden="true">
            {includePassed && <CheckIcon size={12} />}
          </span>
          <span className="rw-monitor-option-label">{t('monitor.includePassed')}</span>
        </button>
      </OptionsMenu>

      <span className={`rw-monitor-pill-text${allPassed ? ' rw-monitor-pill-text--passed' : ''}`} aria-live="polite">
        {allPassed && <CheckIcon size={12} />}
        {summary}
      </span>

      {!allPassed && (
        <>
          <IconButton icon={<ChevronLeftIcon size={13} />} label={t('monitor.previous')} onClick={() => go(-1)} />
          <IconButton icon={<ChevronRightIcon size={13} />} label={t('monitor.next')} onClick={() => go(1)} />
        </>
      )}

      {findings.truncated && (
        <Tooltip label={t('monitor.truncated', { count: MAX_MONITOR_CANDIDATES })} side="top" className="rw-monitor-truncated">
          <span tabIndex={0} role="img" aria-label={t('monitor.truncated', { count: MAX_MONITOR_CANDIDATES })}>
            <AlertIcon size={12} />
          </span>
        </Tooltip>
      )}
    </div>
  )
}
