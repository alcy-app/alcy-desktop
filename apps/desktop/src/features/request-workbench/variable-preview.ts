import type { EnvironmentVariableDto } from '../../bindings/list-environments'

export type VariablePreviewState = 'defined' | 'sensitive' | 'hidden' | 'undefined'

export interface VariablePreview {
  name: string
  state: VariablePreviewState
  /** Valor a exibir — só no estado `defined`; cortado em `MAX_PREVIEW_CHARS`. */
  value: string | null
  truncated: boolean
}

/** Valores maiores que isso são cortados na pré-visualização (o CSS ainda limita as linhas visíveis). */
export const MAX_PREVIEW_CHARS = 500

/**
 * Estado da pré-visualização de `{{nome}}`: indefinida, sensível (valor
 * nunca exibido), oculta (campo mascarado, como senha — nem o valor de uma
 * variável comum aparece) ou definida, com o valor.
 */
export function variablePreviewFor(
  name: string,
  variables: EnvironmentVariableDto[],
  { hideValue = false }: { hideValue?: boolean } = {},
): VariablePreview {
  const match = variables.find((variable) => variable.name === name)
  if (!match) return { name, state: 'undefined', value: null, truncated: false }
  if (hideValue) return { name, state: 'hidden', value: null, truncated: false }
  if (match.sensitive) return { name, state: 'sensitive', value: null, truncated: false }
  const truncated = match.value.length > MAX_PREVIEW_CHARS
  return { name, state: 'defined', value: truncated ? match.value.slice(0, MAX_PREVIEW_CHARS) : match.value, truncated }
}
