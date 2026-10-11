import { createContext, useContext } from 'react'
import type { VariableSource } from './collection-tree'

/** Grava `value` na variável `name`, criando-a se não existir: na coleção/pasta `source` (ADR 0031) ou, sem
 * `source`, no ambiente ativo. */
export type SetVariableValue = (name: string, value: string, source?: VariableSource) => void

export interface VariableEditing {
  setValue: SetVariableValue
  /** Há ambiente ativo: uma variável indefinida pode ser criada nele. */
  canCreate: boolean
}

/**
 * Edição de variáveis a partir da pré-visualização de `{{variável}}` (hover
 * nos campos e editores da requisição). Fornecido pelo `RequestWorkbench`;
 * `null` deixa a pré-visualização só leitura. Contexto em vez de prop porque os
 * consumidores são os campos com template espalhados por todos os painéis
 * da requisição.
 */
export const VariableEditingContext = createContext<VariableEditing | null>(null)

export function useVariableEditing(): VariableEditing | null {
  return useContext(VariableEditingContext)
}
