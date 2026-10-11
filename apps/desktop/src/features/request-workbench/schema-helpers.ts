import type { LoadSchemaOutput, SchemaField, SchemaInputValue, SchemaType } from '../../bindings/load-schema'
import type { OperationType } from './graphql-query-tree'

/** Índice nome → tipo de cada lista de tipos de um schema (imutável), montado uma vez por lista. */
const typeIndexes = new WeakMap<readonly SchemaType[], Map<string, SchemaType>>()

/**
 * Busca de tipo por nome em O(1). Um schema grande tem milhares de tipos, e a
 * busca linear rodava por campo a cada renderização do explorador e a cada
 * pedido de autocompletar.
 */
export function typeIndexOf(types: readonly SchemaType[]): Map<string, SchemaType> {
  let index = typeIndexes.get(types)
  if (!index) {
    index = new Map(types.map((type) => [type.name, type]))
    typeIndexes.set(types, index)
  }
  return index
}

/** OBJECT/INTERFACE/UNION têm seleção de campos (`{ }`); SCALAR/ENUM não. */
export function fieldHasSubfields(field: SchemaField, types: SchemaType[]): boolean {
  if (!field.typeName) return false
  const referencedType = typeIndexOf(types).get(field.typeName)
  if (!referencedType) return false
  return referencedType.kind === 'OBJECT' || referencedType.kind === 'INTERFACE' || referencedType.kind === 'UNION'
}

/** Tipo raiz do schema correspondente ao tipo de operação da query atual. */
export function rootTypeNameFor(operationType: OperationType, schema: LoadSchemaOutput): string | null {
  if (operationType === 'mutation') return schema.mutationType
  if (operationType === 'subscription') return schema.subscriptionType
  return schema.queryType
}

/** `[String!]`, `[ID]` etc. — tipos envolvidos em lista não têm formatação de literal automática (ver `formatArgumentValue`). */
export function isListArgument(arg: SchemaInputValue): boolean {
  return arg.typeDisplay.includes('[')
}

/**
 * Converte o texto digitado pelo usuário no literal GraphQL do argumento:
 * `String`/`ID` viram string entre aspas (escapando `"`/`\`), o resto passa
 * como está (números, booleanos, enums são identificadores nus). Uma
 * referência a variável (`$nome`) nunca é envolvida em aspas. Tipos em lista
 * ou input object não são reformatados — o usuário digita o literal
 * completo (ex.: `["a", "b"]`).
 */
export function formatArgumentValue(rawInput: string, arg: SchemaInputValue): string {
  const trimmed = rawInput.trim()
  if (trimmed.startsWith('$') || isListArgument(arg)) return trimmed
  if (arg.typeName === 'String' || arg.typeName === 'ID') {
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return `"${escaped}"`
  }
  return trimmed
}

/** Inverso aproximado de `formatArgumentValue`: tira aspas de string/ID para exibir no input. */
export function displayArgumentValue(raw: string | undefined): string {
  if (raw === undefined) return ''
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return trimmed
}
