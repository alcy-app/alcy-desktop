import { describe, expect, it } from 'vitest'
import type { CollectionRunEventDto, RunStepDto } from '../../bindings/execute-collection-run'
import {
  applyRunEvent,
  applyRunEvents,
  countByFilter,
  filterRows,
  idleRunState,
  runRows,
  runStateFromDetail,
  startedRunState,
  summarizeRun,
} from './collection-run-state'

function step(position: number, overrides: Partial<RunStepDto> = {}): RunStepDto {
  return {
    iteration: 0,
    position,
    requestId: `r${position}`,
    name: `Req ${position}`,
    protocol: 'rest',
    method: 'get',
    resolvedUrl: 'https://api.test/',
    outcome: 'passed',
    statusCode: 200,
    durationMs: 10,
    sizeBytes: 2,
    errorMessage: null,
    tests: [],
    logs: [],
    hasOutput: true,
    ...overrides,
  }
}

const run = (events: CollectionRunEventDto[]) =>
  events.reduce((state, event) => applyRunEvent(state, event, 1000), startedRunState('run', 0))

describe('applyRunEvent', () => {
  it('acompanha a requisição em voo e acumula as terminadas', () => {
    const running = run([
      { type: 'runStarted', iterations: 2, requestsPerIteration: 3 },
      { type: 'iterationStarted', iteration: 0 },
      { type: 'requestStarted', iteration: 0, position: 0, requestId: 'r0' },
    ])
    expect(running.current).toEqual({ iteration: 0, position: 0, requestId: 'r0' })
    expect(summarizeRun(running)).toMatchObject({ expected: 6, completed: 0, verdict: 'running' })

    const finished = [
      { type: 'requestFinished', step: step(0) },
      { type: 'runFinished', cancelled: false, stoppedOnError: true, environmentChanges: [], scopedChanges: [] },
    ].reduce<typeof running>((state, event) => applyRunEvent(state, event as CollectionRunEventDto, 1000), running)

    expect(finished.current).toBeNull()
    expect(finished.phase).toBe('finished')
    expect(finished.finishedAtMs).toBe(1000)
    expect(summarizeRun(finished).verdict).toBe('stopped')
  })
})

describe('applyRunEvents', () => {
  it('aplica um lote igual a aplicar evento por evento', () => {
    const events: CollectionRunEventDto[] = [
      { type: 'runStarted', iterations: 1, requestsPerIteration: 2 },
      { type: 'requestStarted', iteration: 0, position: 0, requestId: 'r0' },
      { type: 'requestFinished', step: step(0) },
      { type: 'requestStarted', iteration: 0, position: 1, requestId: 'r1' },
    ]

    const batched = applyRunEvents(startedRunState('run', 0), events, 1000)

    expect(batched).toEqual(run(events))
    expect(batched.current?.position).toBe(1)
  })
})

describe('summarizeRun', () => {
  it('conta resultados, testes e tempos', () => {
    const state = run([
      { type: 'runStarted', iterations: 1, requestsPerIteration: 3 },
      {
        type: 'requestFinished',
        step: step(0, {
          tests: [
            { name: 'a', passed: true, message: null },
            { name: 'b', passed: false, message: 'x' },
          ],
          outcome: 'failed',
        }),
      },
      { type: 'requestFinished', step: step(1, { durationMs: 30 }) },
      { type: 'requestFinished', step: step(2, { outcome: 'error', durationMs: null, statusCode: null }) },
      { type: 'runFinished', cancelled: false, stoppedOnError: false, environmentChanges: [], scopedChanges: [] },
    ])

    expect(summarizeRun(state)).toEqual({
      expected: 3,
      completed: 3,
      passed: 1,
      failed: 1,
      errors: 1,
      testsPassed: 1,
      testsTotal: 2,
      totalDurationMs: 40,
      averageDurationMs: 20,
      verdict: 'failed',
    })
  })

  it('um run cancelado prevalece e um run limpo passa', () => {
    const clean = run([{ type: 'runFinished', cancelled: false, stoppedOnError: false, environmentChanges: [], scopedChanges: [] }])
    const cancelled = run([{ type: 'runFinished', cancelled: true, stoppedOnError: false, environmentChanges: [], scopedChanges: [] }])

    expect(summarizeRun(clean).verdict).toBe('passed')
    expect(summarizeRun(cancelled).verdict).toBe('cancelled')
    expect(summarizeRun(idleRunState).averageDurationMs).toBeNull()
  })
})

describe('filtros e linhas puladas', () => {
  const plan = [
    { requestId: 'r0', name: 'Req 0', protocol: 'rest' as const, method: 'get' },
    { requestId: 'r1', name: 'Req 1', protocol: 'graphql' as const, method: 'post' },
  ]
  const events: CollectionRunEventDto[] = [
    { type: 'runStarted', iterations: 2, requestsPerIteration: 2 },
    { type: 'requestFinished', step: step(0) },
    { type: 'requestFinished', step: step(1, { outcome: 'failed' }) },
    { type: 'requestFinished', step: step(0, { iteration: 1, outcome: 'error' }) },
  ]
  const running = events.reduce(
    (state, event) => applyRunEvent(state, event, 1000),
    startedRunState('run', 0, plan),
  )
  const stopped = applyRunEvent(
    running,
    { type: 'runFinished', cancelled: false, stoppedOnError: true, environmentChanges: [], scopedChanges: [] },
    1000,
  )

  it('durante o run, lista só o que terminou', () => {
    expect(runRows(running)).toHaveLength(3)
  })

  it('com o run encerrado, completa o plano com as requisições puladas', () => {
    const rows = runRows(stopped)

    expect(rows.map((row) => row.outcome)).toEqual(['passed', 'failed', 'error', 'skipped'])
    expect(rows[3]).toMatchObject({ iteration: 1, position: 1, requestId: 'r1', name: 'Req 1', protocol: 'graphql' })
  })

  it('conta e filtra por resultado e iteração, com erro como falha', () => {
    const rows = runRows(stopped)

    expect(countByFilter(rows, null)).toEqual({ all: 4, passed: 1, failed: 2, skipped: 1 })
    expect(countByFilter(rows, 1)).toEqual({ all: 2, passed: 0, failed: 1, skipped: 1 })
    expect(filterRows(rows, 'skipped', null).map((row) => row.requestId)).toEqual(['r1'])
    expect(filterRows(rows, 'failed', 0).map((row) => row.outcome)).toEqual(['failed'])
  })

  it('a requisição cancelada em voo conta como pulada', () => {
    const rows = runRows(
      applyRunEvent(
        applyRunEvent(startedRunState('run', 0, plan), { type: 'runStarted', iterations: 1, requestsPerIteration: 2 }, 0),
        { type: 'requestFinished', step: step(0, { outcome: 'cancelled', statusCode: null }) },
        0,
      ),
    )

    expect(countByFilter(rows, null).skipped).toBe(1)
  })
})

describe('runStateFromDetail', () => {
  it('reconstrói um run terminado do histórico', () => {
    const state = runStateFromDetail({
      id: 'run-1',
      scopeName: 'Loja',
      environmentName: null,
      startedAtMs: 1,
      finishedAtMs: 9,
      cancelled: false,
      stoppedOnError: false,
      iterations: 2,
      options: {
        iterations: 2,
        delayMs: 0,
        stopOnError: false,
        httpErrorsFail: true,
        keepVariableValues: true,
        shareCookies: true,
        persistResponses: true,
        disableLogs: false,
        dataFileName: null,
      },
      plan: [{ requestId: 'r0', name: 'Req', protocol: 'rest', method: 'get' }],
      steps: [step(0)],
      outputs: [],
    })

    expect(state).toMatchObject({ phase: 'finished', iterations: 2, requestsPerIteration: 1, finishedAtMs: 9 })
    expect(summarizeRun(state).expected).toBe(2)
  })
})
