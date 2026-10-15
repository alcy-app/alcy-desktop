import type { InvalidRequestCause, NetworkCause } from '../../bindings/execute-graphql-request'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import type { ExecutionFailure } from './request-workbench.types'

/** Textos do resumo da resposta — compartilhados pelo painel de resposta e
 * pela imagem de compartilhamento (`screenshot/`). */

type Translate = (key: TranslationKey, params?: TranslationParams) => string

export type StatusTone = 'success' | 'redirect' | 'warning' | 'error' | 'neutral'

export function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
}

/** Tempo decorrido de um envio em andamento: décimos de segundo até 1 min
 * (`2.4 s`), depois minutos e segundos (`1m 05s`). */
export function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 60_000) return `${(Math.floor(safe / 100) / 10).toFixed(1)} s`
  const totalSeconds = Math.floor(safe / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** Tamanho em MB binários (1 MB = 1024 × 1024 bytes), na mesma unidade da
 * configuração de limite de resposta — `formatSize` usa base 1000 e mostraria
 * o limite padrão de 50 MB como "52 MB". */
export function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  const rounded = Math.round(megabytes * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MB`
}

export function statusTone(statusCode: number): StatusTone {
  if (statusCode >= 200 && statusCode < 300) return 'success'
  if (statusCode >= 300 && statusCode < 400) return 'redirect'
  if (statusCode >= 400 && statusCode < 500) return 'warning'
  if (statusCode >= 500) return 'error'
  return 'neutral'
}

export function errorLabel(t: Translate, error: ExecutionFailure): string {
  switch (error.kind) {
    case 'invalidRequest':
      return t('response.errorInvalidRequestLabel')
    case 'script':
      return t('response.errorScriptLabel')
    case 'network':
      return t('response.errorNetworkLabel')
    case 'timeout':
      return t('response.errorTimeoutLabel')
    case 'responseTooLarge':
      return t('response.errorResponseTooLargeLabel')
    case 'invalidVariables':
      return t('response.errorInvalidVariablesLabel')
    case 'cancelled':
      return t('response.errorCancelledLabel')
    case 'connection':
      return t('response.errorConnectionLabel')
    case 'schema':
      return t('response.errorSchemaLabel')
  }
}

export function describeError(t: Translate, error: ExecutionFailure): string {
  switch (error.kind) {
    case 'invalidRequest':
      return error.cause ? describeCause(t, error.cause) : t('response.errorInvalidRequest', { message: error.message })
    case 'script':
      return t('response.errorScript', {
        phase: t(error.phase === 'preRequest' ? 'response.scriptPhasePreRequest' : 'response.scriptPhasePostResponse'),
        message: error.message,
      })
    case 'network':
      return error.cause ? describeCause(t, error.cause) : t('response.errorNetwork', { message: error.message })
    case 'timeout':
      return t('common.executionTimedOut')
    case 'responseTooLarge':
      return t('response.errorResponseTooLarge', {
        size: formatMegabytes(error.receivedBytes),
        limit: formatMegabytes(error.limitBytes),
      })
    case 'invalidVariables':
      return t('response.errorInvalidVariables', { message: error.message })
    case 'cancelled':
      return t('response.errorCancelled')
    case 'connection':
      return t('response.errorConnection', { message: error.message })
    case 'schema':
      return t('response.errorSchema', { message: error.message })
  }
}

/** Causa reconhecida pelo backend, descrita no idioma da interface — a
 * mensagem do backend não é traduzida (ADR 0044). */
export function describeCause(t: Translate, cause: InvalidRequestCause | NetworkCause): string {
  const { type, ...params } = cause
  return t(`response.cause.${type}` as const, params)
}

/** Mensagem técnica para exibir abaixo de `describeError` quando a descrição
 * veio de uma causa reconhecida e, portanto, não a inclui. */
export function errorDetail(error: ExecutionFailure): string | null {
  const detailed =
    (error.kind === 'network' && error.cause !== undefined) ||
    (error.kind === 'invalidRequest' && error.cause?.type === 'bodyFileUnreadable')
  return detailed && error.message.trim() !== '' ? error.message : null
}
