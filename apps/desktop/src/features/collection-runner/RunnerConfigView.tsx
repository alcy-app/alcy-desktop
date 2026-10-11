import type { ReactNode } from 'react'
import type { IterationDataPreviewDto } from '../../bindings/preview-iteration-data'
import { DragPreview } from '../../shared/DragPreview'
import { useLanguage } from '../../shared/i18n/use-language'
import { Checkbox } from '../../shared/ui/Checkbox'
import { EmptyState } from '../../shared/ui/EmptyState'
import { Field } from '../../shared/ui/Field'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { CloseIcon, GripIcon, ImportIcon, RunnerIcon, Spinner } from '../../shared/ui/icons'
import { usePointerDrag } from '../../shared/use-pointer-drag'
import type { DropEdge } from '../../shared/use-pointer-drag'
import { VirtualizedList } from '../request-workbench/components/VirtualizedList'
import { MethodBadge } from './MethodBadge'
import type { RunnerPlanItem } from './runner-plan'
import { MAX_DELAY_MS, MAX_ITERATIONS, parseDelay, parseIterations } from './runner-settings'
import type { RunnerSettings } from './runner-settings'

export type DataFileState =
  | { status: 'none' }
  | { status: 'loading'; path: string }
  | { status: 'ready'; path: string; preview: IterationDataPreviewDto }
  | { status: 'error'; path: string; message: string }

type BooleanSetting = {
  [K in keyof RunnerSettings]: RunnerSettings[K] extends boolean ? K : never
}[keyof RunnerSettings]

interface RunnerConfigViewProps {
  items: RunnerPlanItem[]
  deselected: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
  onResetOrder: () => void
  onReorder: (draggedId: string, targetId: string, edge: DropEdge) => void
  settings: RunnerSettings
  onSettingsChange: (patch: Partial<RunnerSettings>) => void
  dataFile: DataFileState
  onPickDataFile: () => void
  onRemoveDataFile: () => void
}

const PLAN_ROW_HEIGHT = 44

export function RunnerConfigView({
  items,
  deselected,
  onToggle,
  onSelectAll,
  onClear,
  onResetOrder,
  onReorder,
  settings,
  onSettingsChange,
  dataFile,
  onPickDataFile,
  onRemoveDataFile,
}: RunnerConfigViewProps) {
  const { t } = useLanguage()
  const { draggedId, draggedLabel, dragOverId, dragOverEdge, position, startDrag } = usePointerDrag<'request'>({
    dropTargetAttribute: 'data-runner-drop-id',
    dropKindAttribute: 'data-runner-drop-kind',
    onDrop: (dragged, target, edge) => onReorder(dragged.id, target.id, edge),
  })
  const selectedCount = items.filter((item) => !deselected.has(item.id)).length
  const hasData = dataFile.status === 'ready'
  const iterationsError =
    !hasData && parseIterations(settings.iterations) === null
      ? t('runner.settings.invalidIterations', { max: String(MAX_ITERATIONS) })
      : undefined
  const delayError =
    parseDelay(settings.delayMs) === null ? t('runner.settings.invalidDelay', { max: String(MAX_DELAY_MS) }) : undefined

  const booleanOption = (key: BooleanSetting, label: string, hint?: string) => (
    <label className="runner-option">
      <Checkbox checked={settings[key]} onChange={(event) => onSettingsChange({ [key]: event.target.checked })} />
      <span className="runner-option-text">
        <span className="runner-option-label">{label}</span>
        {hint && <span className="runner-option-hint">{hint}</span>}
      </span>
    </label>
  )

  return (
    <div className="runner-config">
      <section className="runner-card runner-plan" aria-labelledby="runner-plan-title">
        <header className="runner-card-header">
          <h3 id="runner-plan-title" className="runner-card-title">
            {t('runner.order.title')}
          </h3>
          <span className="runner-plan-count">
            {t('runner.order.selected', { selected: String(selectedCount), total: String(items.length) })}
          </span>
        </header>
        <div className="runner-plan-actions">
          <button type="button" className="runner-link" onClick={onSelectAll} disabled={selectedCount === items.length}>
            {t('runner.order.selectAll')}
          </button>
          <button type="button" className="runner-link" onClick={onClear} disabled={selectedCount === 0}>
            {t('runner.order.clear')}
          </button>
          <button type="button" className="runner-link" onClick={onResetOrder}>
            {t('runner.order.reset')}
          </button>
        </div>
        {items.length === 0 ? (
          <EmptyState icon={<RunnerIcon size={22} />} title={t('runner.order.empty')} />
        ) : (
          <VirtualizedList
            items={items}
            getKey={(item) => item.id}
            estimatedRowHeight={PLAN_ROW_HEIGHT}
            ariaLabel={t('runner.order.listAria')}
            className="runner-plan-list"
            renderItem={(item) => {
              const index = items.indexOf(item)
              const included = !deselected.has(item.id)
              const classes = ['runner-plan-row']
              if (!included) classes.push('runner-plan-row--skipped')
              if (draggedId === item.id) classes.push('runner-plan-row--dragging')
              if (dragOverId === item.id && dragOverEdge) classes.push(`runner-plan-row--drop-${dragOverEdge}`)
              return (
                <div className={classes.join(' ')} data-runner-drop-id={item.id} data-runner-drop-kind="request">
                  <span
                    className="runner-plan-grip"
                    role="img"
                    aria-label={t('runner.order.dragAria', { name: item.name })}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      startDrag(item.id, 'request', item.name, event)
                    }}
                  >
                    <GripIcon size={14} />
                  </span>
                  <Checkbox
                    checked={included}
                    onChange={() => onToggle(item.id)}
                    aria-label={t('runner.order.toggleAria', { name: item.name })}
                  />
                  <span className="runner-plan-index">{index + 1}</span>
                  <MethodBadge protocol={item.protocol} method={item.method} />
                  <span className="runner-plan-name">
                    <span className="runner-plan-title">{item.name}</span>
                    {item.path.length > 0 && <span className="runner-plan-path">{item.path.join(' / ')}</span>}
                  </span>
                </div>
              )
            }}
          />
        )}
        <DragPreview label={draggedLabel} position={position} />
      </section>

      <div className="runner-settings">
        <SettingsCard title={t('runner.settings.execution.title')}>
          <div className="runner-field-row">
            <Field
              label={t('runner.settings.iterations.label')}
              error={iterationsError}
              hint={hasData ? t('runner.settings.iterations.fromData') : undefined}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={MAX_ITERATIONS}
                  className="runner-number"
                  disabled={hasData}
                  value={hasData ? String(dataFile.preview.rowCount) : settings.iterations}
                  onChange={(event) => onSettingsChange({ iterations: event.target.value })}
                  aria-invalid={iterationsError ? true : undefined}
                />
              )}
            </Field>
            <Field label={t('runner.settings.delay.label')} error={delayError}>
              {(id) => (
                <span className="runner-input-suffix">
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={MAX_DELAY_MS}
                    step={100}
                    className="runner-number"
                    value={settings.delayMs}
                    onChange={(event) => onSettingsChange({ delayMs: event.target.value })}
                    aria-invalid={delayError ? true : undefined}
                  />
                  <span className="runner-input-unit" aria-hidden="true">
                    ms
                  </span>
                </span>
              )}
            </Field>
          </div>
          <div className="ui-field">
            <span className="ui-field-label">{t('runner.settings.data.label')}</span>
            <DataFileControl state={dataFile} onPick={onPickDataFile} onRemove={onRemoveDataFile} />
            <p className="ui-field-hint">{t('runner.settings.data.hint')}</p>
          </div>
        </SettingsCard>

        <SettingsCard title={t('runner.settings.behavior.title')}>
          {booleanOption('stopOnError', t('runner.settings.stopOnError.label'))}
          {booleanOption(
            'httpErrorsFail',
            t('runner.settings.httpErrorsFail.label'),
            t('runner.settings.httpErrorsFail.hint'),
          )}
          {booleanOption(
            'keepVariableValues',
            t('runner.settings.keepVariables.label'),
            t('runner.settings.keepVariables.hint'),
          )}
          {booleanOption('shareCookies', t('runner.settings.shareCookies.label'), t('runner.settings.shareCookies.hint'))}
        </SettingsCard>

        <SettingsCard title={t('runner.settings.logging.title')}>
          {booleanOption(
            'persistResponses',
            t('runner.settings.persistResponses.label'),
            t('runner.settings.persistResponses.hint'),
          )}
          {booleanOption('disableLogs', t('runner.settings.disableLogs.label'))}
          {booleanOption('saveToHistory', t('runner.settings.saveToHistory.label'), t('runner.settings.saveToHistory.hint'))}
        </SettingsCard>
      </div>
    </div>
  )
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="runner-card runner-settings-card">
      <h3 className="runner-card-title">{title}</h3>
      <div className="runner-settings-body">{children}</div>
    </section>
  )
}

function DataFileControl({
  state,
  onPick,
  onRemove,
}: {
  state: DataFileState
  onPick: () => void
  onRemove: () => void
}) {
  const { t } = useLanguage()

  if (state.status === 'none') {
    return (
      <button type="button" className="runner-data-pick" onClick={onPick}>
        <ImportIcon size={14} />
        {t('runner.settings.data.choose')}
      </button>
    )
  }

  const fileName = state.status === 'ready' ? state.preview.fileName : state.path.split(/[\\/]/).pop()
  return (
    <div className={`runner-data-file${state.status === 'error' ? ' runner-data-file--error' : ''}`}>
      <span className="runner-data-file-text">
        <span className="runner-data-file-name">{fileName}</span>
        <span className="runner-data-file-meta">
          {state.status === 'loading' && (
            <>
              <Spinner size={11} /> {t('runner.settings.data.loading')}
            </>
          )}
          {state.status === 'ready' &&
            t('runner.settings.data.summary', {
              rows: String(state.preview.rowCount),
              columns: state.preview.columns.join(', '),
            })}
          {state.status === 'error' && state.message}
        </span>
      </span>
      <IconButton icon={<CloseIcon size={12} />} label={t('runner.settings.data.removeAria')} onClick={onRemove} />
    </div>
  )
}
