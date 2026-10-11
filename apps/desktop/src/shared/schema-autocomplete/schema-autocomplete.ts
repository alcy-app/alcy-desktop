/** Preferência "Sugestões a partir da documentação importada" (aba Geral). */
export const SCHEMA_AUTOCOMPLETE_STORAGE_KEY = 'alcy:schema-autocomplete'

export const DEFAULT_SCHEMA_AUTOCOMPLETE = true

/** Só um `false` salvo desliga; ausente, inválido ou armazenamento
 * indisponível mantém o padrão (habilitado). */
export function readSchemaAutocomplete(): boolean {
  try {
    return window.localStorage.getItem(SCHEMA_AUTOCOMPLETE_STORAGE_KEY) !== 'false'
  } catch {
    return DEFAULT_SCHEMA_AUTOCOMPLETE
  }
}

export function writeSchemaAutocomplete(enabled: boolean) {
  try {
    window.localStorage.setItem(SCHEMA_AUTOCOMPLETE_STORAGE_KEY, String(enabled))
  } catch {
    // Sem armazenamento, a escolha vale só para esta sessão.
  }
}
