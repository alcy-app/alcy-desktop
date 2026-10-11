import type { LoadSchemaError } from '../../bindings/load-schema'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { describeCause } from './response-summary'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** Shared by the Schema tab and the query explorer — both surface the same `loadSchema` failures. */
export function describeSchemaError(t: Translate, error: LoadSchemaError): string {
  switch (error.kind) {
    case 'invalidRequest':
      return error.cause ? describeCause(t, error.cause) : t('schema.errorInvalidRequest', { message: error.message })
    case 'network':
      return error.cause ? describeCause(t, error.cause) : t('schema.errorNetwork', { message: error.message })
    case 'timeout':
      return t('common.executionTimedOut')
    case 'cancelled':
      return t('schema.errorCancelled')
    case 'invalidResponse':
      return t(`schema.cause.${error.cause.type}` as const)
  }
}

/** Mensagem técnica para exibir abaixo de `describeSchemaError` quando a
 * descrição veio de uma causa reconhecida e, portanto, não a inclui. */
export function schemaErrorDetail(error: LoadSchemaError): string | null {
  const detailed =
    (error.kind === 'network' && error.cause !== undefined) ||
    (error.kind === 'invalidRequest' && error.cause?.type === 'bodyFileUnreadable') ||
    error.kind === 'invalidResponse'
  return detailed && error.message.trim() !== '' ? error.message : null
}
