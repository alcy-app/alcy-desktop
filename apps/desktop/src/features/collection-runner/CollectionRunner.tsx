import { useCallback, useMemo, useState } from 'react'
import { useAgentResourceController, type AgentResourceBridge } from '../agent/agent-resource-bridge'
import type { ReactNode } from 'react'
import type { ExecuteCollectionRunError, RunStepDto } from '../../bindings/execute-collection-run'
import type { EnvironmentChange, ScopedVariableChange } from '../../bindings/execute-graphql-request'
import { getCollectionRunOutput } from '../../bindings/get-collection-run-output'
import type { CollectionRunDetailDto } from '../../bindings/get-collection-run-history'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { pickDataFile } from '../../bindings/pick-data-file'
import { previewIterationData } from '../../bindings/preview-iteration-data'
import { useLanguage } from '../../shared/i18n/use-language'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { Button } from '../../shared/ui/Button'
import { EmptyState } from '../../shared/ui/EmptyState'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { PlayIcon, PlusIcon, RunnerIcon, StopIcon } from '../../shared/ui/icons'
import { findNode } from '../request-workbench/collection-tree'
import type { TreeNode } from '../request-workbench/collection-tree'
import { runStateFromDetail, summarizeRun } from './collection-run-state'
import type { CollectionRunState, RunVerdict } from './collection-run-state'
import { RunnerConfigView } from './RunnerConfigView'
import type { DataFileState } from './RunnerConfigView'
import { ReportExportMenu } from './ReportExportMenu'
import { RunnerResultsView } from './RunnerResultsView'
import type { LoadStepOutput } from './RunnerResultsView'
import { flattenScope, reconcileOrder, reorderPlan, scopePath, selectedInOrder } from './runner-plan'
import { DEFAULT_RUNNER_SETTINGS, toRunOptions } from './runner-settings'
import type { RunnerSettings } from './runner-settings'
import { useCollectionRun } from './use-collection-run'
import './collection-runner.css'

/** A collection/folder runner tab, or a read-only historical run report. */
export interface RunnerTab {
  id: string
  label: string
  scopeId: string | null
  report: CollectionRunDetailDto | null
}

interface CollectionRunnerProps {
  agentBridge?: AgentResourceBridge
  tab: RunnerTab
  /** Inactive tabs stay mounted and hidden to retain events from ongoing runs. */
  hidden: boolean
  collections: TreeNode[]
  rootPath: string
  environmentVariables: EnvironmentVariableDto[]
  environmentName: string | null
  onBeforeRun: () => Promise<void>
  onEnvironmentChanges: (changes: EnvironmentChange[]) => void
  onScopedChanges?: (changes: ScopedVariableChange[]) => void
  onRunFinished: () => void
  onStepLogged: (step: RunStepDto) => void
}

type Translate = (key: TranslationKey, params?: TranslationParams) => string

export function CollectionRunner(props: CollectionRunnerProps) {
  const { tab, hidden } = props
  return (
    <div className="runner" hidden={hidden}>
      {tab.report ? <RunnerReport detail={tab.report} rootPath={props.rootPath} /> : <LiveRunner {...props} />}
    </div>
  )
}

function verdictTone(verdict: RunVerdict): string {
  switch (verdict) {
    case 'running':
      return 'running'
    case 'passed':
      return 'success'
    case 'failed':
    case 'stopped':
      return 'error'
    case 'cancelled':
      return 'muted'
  }
}

/** Format a run time with its date when it is not today. */
function ranAtText(ms: number, language: string, t: Translate): string {
  const date = new Date(ms)
  const time = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
  if (date.toDateString() === new Date().toDateString()) return t('runner.results.ranToday', { time })
  const day = new Intl.DateTimeFormat(language, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
  return t('runner.results.ranOn', { date: day, time })
}

/** A compact run status and start time. */
function RunStatusLine({ state, extra }: { state: CollectionRunState; extra?: string }) {
  const { t, language } = useLanguage()
  const verdict = summarizeRun(state).verdict
  return (
    <>
      <span className={`runner-status-text runner-status-text--${verdictTone(verdict)}`}>
        <span className="runner-status-dot" aria-hidden="true" />
        {t(`runner.results.status.${verdict}`)}
      </span>
      {state.startedAtMs !== null && <span>{ranAtText(state.startedAtMs, language, t)}</span>}
      {extra && <span>{extra}</span>}
    </>
  )
}

function RunnerHeader({ title, subtitle, actions }: { title: string; subtitle: ReactNode; actions?: ReactNode }) {
  return (
    <header className="runner-header">
      <div className="runner-header-text">
        <h2 className="runner-title">{title}</h2>
        <p className="runner-header-details">{subtitle}</p>
      </div>
      {actions && <div className="runner-header-actions">{actions}</div>}
    </header>
  )
}

function startErrorMessage(error: ExecuteCollectionRunError, t: Translate): string {
  switch (error.kind) {
    case 'emptyPlan':
      return t('runner.error.emptyPlan')
    case 'dataFile':
      return t('runner.error.dataFile', { message: error.message })
    case 'invalidOptions':
      return t('runner.error.invalidOptions', { message: error.message })
    case 'storage':
      return t('runner.error.storage', { message: error.message })
  }
}

function LiveRunner({
  agentBridge,
  tab,
  collections,
  rootPath,
  environmentVariables,
  environmentName,
  onBeforeRun,
  onEnvironmentChanges,
  onScopedChanges,
  onRunFinished,
  onStepLogged,
}: CollectionRunnerProps) {
  const { t } = useLanguage()
  const scope = tab.scopeId ? findNode(collections, tab.scopeId) : null
  const items = useMemo(() => (scope ? flattenScope(scope) : []), [scope])
  const [order, setOrder] = useState<string[] | null>(null)
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set())
  const [settings, setSettings] = useState<RunnerSettings>(DEFAULT_RUNNER_SETTINGS)
  const [dataFile, setDataFile] = useState<DataFileState>({ status: 'none' })
  const [view, setView] = useState<'config' | 'results'>('config')
  const run = useCollectionRun({
    rootPath,
    onBeforeRun,
    onEnvironmentChanges,
    onScopedChanges,
    onRunFinished,
    onStepLogged,
  })

  const orderedItems = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]))
    return reconcileOrder(order ?? [], items).flatMap((id) => byId.get(id) ?? [])
  }, [items, order])
  const requestIds = selectedInOrder(
    orderedItems.map((item) => item.id),
    deselected,
  )
  const options = toRunOptions(
    dataFile.status === 'ready' ? { ...settings, iterations: '1' } : settings,
  )
  const running = run.state.phase === 'running'
  const canRun = requestIds.length > 0 && options !== null && (dataFile.status === 'none' || dataFile.status === 'ready')

  const loadOutput = useCallback<LoadStepOutput>(
    (step) => (run.state.runId ? getCollectionRunOutput(run.state.runId, step.iteration, step.position) : Promise.resolve(null)),
    [run.state.runId],
  )

  const startRun = async () => {
    if (!scope || !options || !canRun || running) throw new Error('The runner cannot start with this configuration.')
    setView('results')
    const selected = new Set(requestIds)
    return run.start({
      scopeName: scope.name,
      plan: orderedItems
        .filter((item) => selected.has(item.id))
        .map((item) => ({ requestId: item.id, name: item.name, protocol: item.protocol, method: item.method })),
      options,
      dataFilePath: dataFile.status === 'ready' ? dataFile.path : null,
      environmentVariables,
      environmentName,
    })
  }

  const chooseDataFile = async () => {
    if (running) throw new Error('Cannot configure a running runner.')
    const path = await pickDataFile()
    if (!path) return
    setDataFile({ status: 'loading', path })
    const result = await previewIterationData(path)
    setDataFile(
      result.ok
        ? { status: 'ready', path, preview: result.value }
        : { status: 'error', path, message: startErrorMessage(result.error, t) },
    )
  }

  useAgentResourceController(agentBridge, 'runner', tab.id, {
    read: () => ({ requestIds, settings, dataFile, state: run.state, error: run.startError }),
    configure: (configuration) => {
      if (running) throw new Error('Cannot configure a running runner.')
      const ids = configuration.requestIds
      if (new Set(ids).size !== ids.length || ids.some((id) => !items.some((item) => item.id === id))) throw new Error('Request selection contains duplicate or unknown ids.')
      if (!toRunOptions(configuration.settings)) throw new Error('Invalid runner options.')
      setOrder([...ids, ...items.map((item) => item.id).filter((id) => !ids.includes(id))])
      setDeselected(new Set(items.filter((item) => !ids.includes(item.id)).map((item) => item.id)))
      setSettings(configuration.settings)
    },
    pickDataFile: chooseDataFile,
    clearDataFile: () => { if (running) throw new Error('Cannot configure a running runner.'); setDataFile({ status: 'none' }) },
    restoreDataFile: (value) => { if (running) throw new Error('Cannot configure a running runner.'); setDataFile(value) },
    run: startRun,
    cancel: run.cancel,
  })

  if (!scope) return <EmptyState icon={<RunnerIcon size={24} />} title={t('runner.scopeMissing.title')} />

  const showResults = view === 'results' && run.state.phase !== 'idle'
  // The title already includes the scope name; only folders need their parent path.
  const parentPath = (scopePath(collections, scope.id) ?? []).slice(0, -1)
  const configDetails = [
    ...(parentPath.length > 0 ? [parentPath.join(' / ')] : []),
    t('runner.requestCount', { count: String(items.length) }),
    environmentName ? t('runner.environment', { name: environmentName }) : t('runner.noEnvironment'),
  ]

  return (
    <>
      <RunnerHeader
        title={t(showResults ? 'runner.header.resultsTitle' : 'runner.header.configTitle', { name: scope.name })}
        subtitle={
          showResults ? (
            <RunStatusLine state={run.state} />
          ) : (
            configDetails.map((detail) => <span key={detail}>{detail}</span>)
          )
        }
        actions={
          showResults ? (
            running ? (
              <Button variant="ghost" className="runner-action runner-action--danger" onClick={run.cancel}>
                <StopIcon size={11} />
                {t('runner.results.cancel')}
              </Button>
            ) : (
              <>
                {run.state.runId && (
                  <ReportExportMenu rootPath={rootPath} runId={run.state.runId} fileName={scope.name} />
                )}
                <Button variant="ghost" className="runner-action" onClick={() => { void startRun().catch(() => undefined) }} disabled={!canRun}>
                  <PlayIcon size={11} />
                  {t('runner.results.runAgain')}
                </Button>
                <Button variant="ghost" className="runner-action" onClick={() => setView('config')}>
                  <PlusIcon size={12} />
                  {t('runner.results.newRun')}
                </Button>
              </>
            )
          ) : (
            <>
              {run.state.phase !== 'idle' && (
                <Button variant="ghost" className="runner-action" onClick={() => setView('results')}>
                  {t('runner.results.viewLast')}
                </Button>
              )}
              <Button onClick={() => { void startRun().catch(() => undefined) }} disabled={!canRun || running}>
                <PlayIcon size={11} />
                {t('runner.runButton', { count: String(requestIds.length) })}
              </Button>
            </>
          )
        }
      />

      {run.startError && (
        <div className="runner-alert">
          <InlineAlert>{startErrorMessage(run.startError, t)}</InlineAlert>
        </div>
      )}

      {showResults ? (
        <RunnerResultsView state={run.state} loadOutput={loadOutput} environmentName={environmentName} />
      ) : (
        <RunnerConfigView
          items={orderedItems}
          deselected={deselected}
          onToggle={(id) =>
            setDeselected((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onSelectAll={() => setDeselected(new Set())}
          onClear={() => setDeselected(new Set(items.map((item) => item.id)))}
          onResetOrder={() => setOrder(null)}
          onReorder={(draggedId, targetId, edge) =>
            setOrder(reorderPlan(orderedItems.map((item) => item.id), draggedId, targetId, edge))
          }
          settings={settings}
          onSettingsChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
          dataFile={dataFile}
          onPickDataFile={() => void chooseDataFile()}
          onRemoveDataFile={() => setDataFile({ status: 'none' })}
        />
      )}
    </>
  )
}

function RunnerReport({ detail, rootPath }: { detail: CollectionRunDetailDto; rootPath: string }) {
  const { t } = useLanguage()
  const state = useMemo(() => runStateFromDetail(detail), [detail])
  const loadOutput = useCallback<LoadStepOutput>(
    async (step) =>
      detail.outputs.find((output) => output.iteration === step.iteration && output.position === step.position) ?? null,
    [detail],
  )

  return (
    <>
      <RunnerHeader
        title={t('runner.header.resultsTitle', { name: detail.scopeName })}
        subtitle={<RunStatusLine state={state} extra={t('runner.report.label')} />}
        actions={<ReportExportMenu rootPath={rootPath} runId={detail.id} fileName={detail.scopeName} />}
      />
      <RunnerResultsView
        state={state}
        loadOutput={loadOutput}
        environmentName={detail.environmentName}
        dataFileName={detail.options.dataFileName}
      />
    </>
  )
}
