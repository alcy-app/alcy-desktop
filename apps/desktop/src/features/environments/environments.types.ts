export interface VariableRow {
  id: string
  name: string
  value: string
  sensitive: boolean
}

export interface EnvironmentState {
  id: string
  name: string
  variables: VariableRow[]
}

/** Substituto exibido no lugar do valor de variáveis sensíveis na edição em massa. */
export const SENSITIVE_MASK = '••••••••'
