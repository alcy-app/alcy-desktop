import type { CSSProperties } from 'react'
import type { TranslationKey } from '../../../shared/i18n/translations'
import type { ConsoleEntry } from '../use-console-state'

export type ConsoleEntryLevel = 'info' | 'warning' | 'error'

export const ERROR_LABEL_KEY: Record<Exclude<ConsoleEntry['errorKind'], null>, TranslationKey> = {
  invalidRequest: 'response.errorInvalidRequestLabel',
  script: 'response.errorScriptLabel',
  network: 'response.errorNetworkLabel',
  timeout: 'response.errorTimeoutLabel',
  responseTooLarge: 'response.errorResponseTooLargeLabel',
  invalidVariables: 'response.errorInvalidVariablesLabel',
  cancelled: 'response.errorCancelledLabel',
  connection: 'response.errorConnectionLabel',
  schema: 'response.errorSchemaLabel',
}

export function entryLevel(entry: ConsoleEntry): ConsoleEntryLevel {
  if (entry.kind === 'script') return entry.outcome === 'error' ? 'error' : 'info'
  if (entry.outcome === 'error') return entry.errorKind === 'cancelled' ? 'warning' : 'error'
  if (entry.hasGraphqlErrors) return 'warning'
  return entry.statusCode !== null && entry.statusCode >= 400 ? 'error' : 'info'
}

/**
 * Largura da coluna de horário em `ch`, medida pelo próprio formatador: assim o
 * sufixo AM/PM (ou o formato de qualquer idioma) cabe sem invadir as colunas
 * vizinhas, e a coluna acompanha a escala de texto.
 */
export function timeColumnStyle(formatter: Intl.DateTimeFormat): CSSProperties {
  const sample = formatter.format(new Date(2000, 0, 1, 22, 22, 22, 222))
  return { '--console-time-width': `${sample.length}ch` } as CSSProperties
}
