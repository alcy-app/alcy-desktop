import type { SchemaType } from '../../bindings/load-schema'
import type { ParsedQuery, SelectionNode } from './graphql-query-tree'

export interface QueryValidationIssue {
  /** Caminho de nomes de campo até o problema, útil para exibição. */
  path: string[]
  kind: 'unknownField'
  fieldName: string
  typeName: string
}

/**
 * Confere se cada campo selecionado existe no tipo correspondente do
 * schema, recursivamente. Não valida argumentos, tipos de variáveis nem
 * fragment spreads (opacos — não temos a definição do fragmento à mão) —
 * só "esse nome de campo existe aqui", que é o que "lint de campos
 * inexistentes" pede.
 */
export function validateQuery(parsed: ParsedQuery, types: SchemaType[], rootTypeName: string | null): QueryValidationIssue[] {
  if (!rootTypeName) return []
  const rootType = types.find((type) => type.name === rootTypeName)
  if (!rootType) return []
  return validateSelections(parsed.selections, rootType, types, [])
}

function validateSelections(
  selections: SelectionNode[],
  type: SchemaType,
  types: SchemaType[],
  path: string[],
): QueryValidationIssue[] {
  const issues: QueryValidationIssue[] = []

  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') continue

    const field = type.fields.find((candidate) => candidate.name === selection.name)
    const fieldPath = [...path, selection.name]

    if (!field) {
      issues.push({ path: fieldPath, kind: 'unknownField', fieldName: selection.name, typeName: type.name })
      continue
    }

    if (selection.children && field.typeName) {
      const childType = types.find((candidate) => candidate.name === field.typeName)
      if (childType) {
        issues.push(...validateSelections(selection.children, childType, types, fieldPath))
      }
    }
  }

  return issues
}
