import type { CollectionRunEventDto, RunStepDto } from '../../bindings/execute-collection-run'
import type { CollectionRunDetailDto } from '../../bindings/get-collection-run-history'

export type RunPhase = 'idle' | 'running' | 'finished'

/** Uma requisição do plano, para listar as que não chegaram a rodar. */
export interface RunPlanEntry {
  requestId: string
  name: string
  protocol: 'rest' | 'graphql' | 'grpc' | null
  method: string
}

/** Estado de um run, reconstruído a partir dos eventos do canal (ao vivo)
 * ou do detalhe gravado no histórico. */
export interface CollectionRunState {
  runId: string | null
  phase: RunPhase
  iterations: number
  requestsPerIteration: number
  plan: RunPlanEntry[]
  /** Requisição em voo. */
  current: { iteration: number; position: number; requestId: string } | null
  steps: RunStepDto[]
  cancelled: boolean
  stoppedOnError: boolean
  startedAtMs: number | null
  finishedAtMs: number | null
}

export const idleRunState: CollectionRunState = {
  runId: null,
  phase: 'idle',
  iterations: 0,
  requestsPerIteration: 0,
  plan: [],
  current: null,
  steps: [],
  cancelled: false,
  stoppedOnError: false,
  startedAtMs: null,
  finishedAtMs: null,
}

export function startedRunState(runId: string, nowMs: number, plan: RunPlanEntry[] = []): CollectionRunState {
  return { ...idleRunState, runId, phase: 'running', startedAtMs: nowMs, plan }
}

export function applyRunEvent(state: CollectionRunState, event: CollectionRunEventDto, nowMs: number): CollectionRunState {
  switch (event.type) {
    case 'runStarted':
      return { ...state, iterations: event.iterations, requestsPerIteration: event.requestsPerIteration }
    case 'iterationStarted':
      return state
    case 'requestStarted':
      return {
        ...state,
        current: { iteration: event.iteration, position: event.position, requestId: event.requestId },
      }
    case 'requestFinished':
      return { ...state, current: null, steps: [...state.steps, event.step] }
    case 'runFinished':
      return {
        ...state,
        phase: 'finished',
        current: null,
        cancelled: event.cancelled,
        stoppedOnError: event.stoppedOnError,
        finishedAtMs: nowMs,
      }
  }
}

/** Aplica um lote de eventos de uma vez (uma cópia de `steps` por lote). */
export function applyRunEvents(state: CollectionRunState, events: CollectionRunEventDto[], nowMs: number): CollectionRunState {
  const finished = events.filter((event) => event.type === 'requestFinished').map((event) => event.step)
  const others = events.filter((event) => event.type !== 'requestFinished')
  let next = finished.length > 0 ? { ...state, steps: [...state.steps, ...finished], current: null } : state
  for (const event of others) {
    // Um `requestStarted` anterior a um `requestFinished` do mesmo lote não
    // deve reabrir uma requisição que já terminou.
    if (event.type === 'requestStarted' && finished.some((step) => sameStep(step, event))) continue
    next = applyRunEvent(next, event, nowMs)
  }
  return next
}

function sameStep(step: RunStepDto, event: { iteration: number; position: number }): boolean {
  return step.iteration === event.iteration && step.position === event.position
}

export function runStateFromDetail(detail: CollectionRunDetailDto): CollectionRunState {
  return {
    runId: detail.id,
    phase: 'finished',
    iterations: detail.iterations,
    requestsPerIteration: detail.plan.length,
    plan: detail.plan.map((item) => ({
      requestId: item.requestId,
      name: item.name,
      protocol: item.protocol === 'rest' || item.protocol === 'graphql' || item.protocol === 'grpc' ? item.protocol : null,
      method: item.method,
    })),
    current: null,
    steps: detail.steps,
    cancelled: detail.cancelled,
    stoppedOnError: detail.stoppedOnError,
    startedAtMs: detail.startedAtMs,
    finishedAtMs: detail.finishedAtMs,
  }
}

export type RunOutcomeTone = 'running' | 'success' | 'error' | 'warning' | 'muted'

/** Como o run terminou, para o badge do cabeçalho. */
export type RunVerdict = 'running' | 'passed' | 'failed' | 'cancelled' | 'stopped'

export interface RunSummary {
  /** Total previsto (iterações × requisições). */
  expected: number
  completed: number
  passed: number
  failed: number
  errors: number
  testsPassed: number
  testsTotal: number
  totalDurationMs: number
  averageDurationMs: number | null
  verdict: RunVerdict
}

export function summarizeRun(state: CollectionRunState): RunSummary {
  let passed = 0
  let failed = 0
  let errors = 0
  let testsPassed = 0
  let testsTotal = 0
  let totalDurationMs = 0
  let timed = 0
  for (const step of state.steps) {
    if (step.outcome === 'passed') passed += 1
    else if (step.outcome === 'failed') failed += 1
    else errors += 1
    testsTotal += step.tests.length
    testsPassed += step.tests.filter((test) => test.passed).length
    if (step.durationMs !== null) {
      totalDurationMs += step.durationMs
      timed += 1
    }
  }
  const verdict: RunVerdict =
    state.phase === 'running'
      ? 'running'
      : state.cancelled
        ? 'cancelled'
        : state.stoppedOnError
          ? 'stopped'
          : failed + errors > 0
            ? 'failed'
            : 'passed'
  return {
    expected: state.iterations * state.requestsPerIteration,
    completed: state.steps.length,
    passed,
    failed,
    errors,
    testsPassed,
    testsTotal,
    totalDurationMs,
    averageDurationMs: timed > 0 ? Math.round(totalDurationMs / timed) : null,
    verdict,
  }
}

/** Resultado exibido de uma linha: o do backend ou `skipped` para uma
 * requisição do plano que não chegou a rodar (run cancelado ou parado). */
export type RowOutcome = RunStepDto['outcome'] | 'skipped'

export type RunRow = Omit<RunStepDto, 'outcome'> & { outcome: RowOutcome }

/** Linhas do relatório: as requisições terminadas e, com o run encerrado,
 * as que ficaram de fora, na ordem iteração → posição. */
export function runRows(state: CollectionRunState): RunRow[] {
  if (state.phase !== 'finished' || state.plan.length === 0) return state.steps
  const done = new Map(state.steps.map((step) => [stepKey(step), step]))
  const rows: RunRow[] = []
  for (let iteration = 0; iteration < state.iterations; iteration += 1) {
    state.plan.forEach((item, position) => {
      const step = done.get(stepKey({ iteration, position }))
      rows.push(
        step ?? {
          iteration,
          position,
          requestId: item.requestId,
          name: item.name,
          protocol: item.protocol,
          method: item.method,
          resolvedUrl: '',
          outcome: 'skipped',
          statusCode: null,
          durationMs: null,
          sizeBytes: null,
          errorMessage: null,
          tests: [],
          logs: [],
          hasOutput: false,
        },
      )
    })
  }
  return rows
}

export type StepFilter = 'all' | 'passed' | 'failed' | 'skipped'

/** Em qual filtro (além de `all`) cada resultado entra: erros contam como
 * falha; a requisição cancelada em voo, como pulada. */
export function filterOf(outcome: RowOutcome): Exclude<StepFilter, 'all'> {
  switch (outcome) {
    case 'passed':
      return 'passed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'skipped':
      return 'skipped'
  }
}

export function countByFilter(rows: RunRow[], iteration: number | null): Record<StepFilter, number> {
  const counts: Record<StepFilter, number> = { all: 0, passed: 0, failed: 0, skipped: 0 }
  for (const row of rows) {
    if (iteration !== null && row.iteration !== iteration) continue
    counts.all += 1
    counts[filterOf(row.outcome)] += 1
  }
  return counts
}

export function filterRows(rows: RunRow[], filter: StepFilter, iteration: number | null): RunRow[] {
  return rows.filter(
    (row) => (iteration === null || row.iteration === iteration) && (filter === 'all' || filterOf(row.outcome) === filter),
  )
}

export function stepKey(step: { iteration: number; position: number }): string {
  return `${step.iteration}:${step.position}`
}

export function stepTone(step: { outcome: RowOutcome }): RunOutcomeTone {
  switch (step.outcome) {
    case 'passed':
      return 'success'
    case 'failed':
      return 'error'
    case 'error':
      return 'warning'
    case 'cancelled':
    case 'skipped':
      return 'muted'
  }
}
