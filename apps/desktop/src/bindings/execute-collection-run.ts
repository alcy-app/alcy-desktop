import { Channel, invoke } from '@tauri-apps/api/core'
import type { EnvironmentChange, ScopedVariableChange, ScriptTestResult } from './execute-graphql-request'
import type { EnvironmentVariableDto } from './list-environments'

/** Configuração de um run do runner de coleções (spec 0073). */
export interface CollectionRunOptionsDto {
  iterations: number
  delayMs: number
  stopOnError: boolean
  httpErrorsFail: boolean
  keepVariableValues: boolean
  shareCookies: boolean
  persistResponses: boolean
  saveToHistory: boolean
  /** Só apresentação: omite os logs de script dos eventos e do histórico. */
  disableLogs: boolean
}

export interface ExecuteCollectionRunInput {
  runId: string
  rootPath: string
  /** Nome da coleção/pasta, para rotular o run no histórico. */
  scopeName: string
  /** Requisições selecionadas, na ordem de execução. */
  requestIds: string[]
  options: CollectionRunOptionsDto
  environmentVariables: EnvironmentVariableDto[]
  dataFilePath?: string | null
  /** Ambiente ativo, só para rotular o run. */
  environmentName?: string | null
}

export type RunStepOutcome = 'passed' | 'failed' | 'error' | 'cancelled'

/** Uma requisição terminada — mesmo formato no canal ao vivo e no histórico. */
export interface RunStepDto {
  iteration: number
  position: number
  requestId: string
  name: string
  /** `null` quando a requisição não existe mais. */
  protocol: 'rest' | 'graphql' | 'grpc' | null
  method: string
  /** URL chamada, com segredos mascarados. */
  resolvedUrl: string
  outcome: RunStepOutcome
  statusCode: number | null
  durationMs: number | null
  sizeBytes: number | null
  errorMessage: string | null
  tests: ScriptTestResult[]
  logs: string[]
  /** A resposta foi guardada e pode ser buscada sob demanda. */
  hasOutput: boolean
}

export type CollectionRunEventDto =
  | { type: 'runStarted'; iterations: number; requestsPerIteration: number }
  | { type: 'iterationStarted'; iteration: number }
  | { type: 'requestStarted'; iteration: number; position: number; requestId: string }
  | { type: 'requestFinished'; step: RunStepDto }
  | {
      type: 'runFinished'
      cancelled: boolean
      stoppedOnError: boolean
      environmentChanges: EnvironmentChange[]
      /** Variáveis de coleção/pasta gravadas pelos scripts (ADR 0031). */
      scopedChanges: ScopedVariableChange[]
    }

export type ExecuteCollectionRunError =
  | { kind: 'invalidOptions'; message: string }
  | { kind: 'emptyPlan' }
  | { kind: 'dataFile'; message: string }
  | { kind: 'storage'; message: string }

export type ExecuteCollectionRunResult = { ok: true } | { ok: false; error: ExecuteCollectionRunError }

/** Erros antes do run começar voltam pela rejeição, sem evento; depois disso
 * o run só termina quando `onEvent` recebe `runFinished`. */
export async function executeCollectionRun(
  input: ExecuteCollectionRunInput,
  onEvent: (event: CollectionRunEventDto) => void,
): Promise<ExecuteCollectionRunResult> {
  const channel = new Channel<CollectionRunEventDto>()
  channel.onmessage = onEvent
  try {
    await invoke('execute_collection_run', { input, onEvent: channel })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error as ExecuteCollectionRunError }
  }
}
