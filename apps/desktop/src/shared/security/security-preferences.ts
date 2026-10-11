export const HAR_REDACTION_STORAGE_KEY = 'alcy:security:har-redact-sensitive'
export const DEFAULT_HAR_REDACTION = true

/** Ocultar dados sensíveis no Gravador HAR é o padrão: só o valor literal
 * `'false'` (um opt-out explícito) desliga. Valor ausente, inválido ou
 * armazenamento indisponível mantêm a proteção ligada. */
export function readStoredHarRedaction(): boolean {
  try {
    return window.localStorage.getItem(HAR_REDACTION_STORAGE_KEY) !== 'false'
  } catch {
    return DEFAULT_HAR_REDACTION
  }
}
