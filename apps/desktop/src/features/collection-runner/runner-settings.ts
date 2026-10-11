import type { CollectionRunOptionsDto } from '../../bindings/execute-collection-run'

export const MAX_ITERATIONS = 1000
export const MAX_DELAY_MS = 600_000

/** Opções editáveis do runner; números como texto enquanto o usuário digita. */
export interface RunnerSettings {
  iterations: string
  delayMs: string
  stopOnError: boolean
  httpErrorsFail: boolean
  keepVariableValues: boolean
  shareCookies: boolean
  persistResponses: boolean
  saveToHistory: boolean
  disableLogs: boolean
}

export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  iterations: '1',
  delayMs: '0',
  stopOnError: false,
  httpErrorsFail: true,
  keepVariableValues: true,
  shareCookies: true,
  persistResponses: true,
  saveToHistory: true,
  disableLogs: false,
}

function parseInteger(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const value = Number(text.trim())
  return value >= min && value <= max ? value : null
}

export function parseIterations(text: string): number | null {
  return parseInteger(text, 1, MAX_ITERATIONS)
}

export function parseDelay(text: string): number | null {
  return text.trim() === '' ? 0 : parseInteger(text, 0, MAX_DELAY_MS)
}

/** Opções prontas para o backend, ou `null` se algum número é inválido. */
export function toRunOptions(settings: RunnerSettings): CollectionRunOptionsDto | null {
  const iterations = parseIterations(settings.iterations)
  const delayMs = parseDelay(settings.delayMs)
  if (iterations === null || delayMs === null) return null
  const { stopOnError, httpErrorsFail, keepVariableValues, shareCookies, persistResponses, saveToHistory, disableLogs } =
    settings
  return {
    iterations,
    delayMs,
    stopOnError,
    httpErrorsFail,
    keepVariableValues,
    shareCookies,
    persistResponses,
    saveToHistory,
    disableLogs,
  }
}
