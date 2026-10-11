import type { ParameterDocDto, ParameterLocation, RequestDocsDto, SchemaNodeDto } from '../../bindings/get-request-docs'
import type { Translate } from './template-highlight'

/** Schemas nomeados de uma operação (`RequestDocsDto.schemas`). */
export type SchemaMap = Record<string, SchemaNodeDto>

/** Limite de profundidade ao combinar `allOf`/`oneOf`/`anyOf` — defesa contra
 * composições cíclicas entre schemas nomeados. */
const MAX_COMPOSITION_DEPTH = 16

/** Segue `refName` até um nó concreto; `null` se a referência não existe ou
 * forma um ciclo só de referências. */
export function resolveSchema(node: SchemaNodeDto, schemas: SchemaMap): SchemaNodeDto | null {
  let current = node
  const seen = new Set<string>()
  while (current.refName !== null) {
    if (seen.has(current.refName)) return null
    seen.add(current.refName)
    const next = schemas[current.refName]
    if (!next) return null
    current = next
  }
  return current
}

/** Rótulo curto do tipo: `string (date-time)`, `array<Pet>`, `Pet`, `integer | null`. */
export function schemaTypeLabel(node: SchemaNodeDto): string {
  if (node.refName !== null) return node.refName
  let label: string
  if (node.types.includes('array') && node.items) {
    label = `array<${schemaTypeLabel(node.items)}>`
  } else if (node.types.length > 0) {
    label = node.types.join(' | ')
    if (node.format) label += ` (${node.format})`
  } else if (node.oneOf.length > 0) {
    label = node.oneOf.map(schemaTypeLabel).join(' | ')
  } else if (node.anyOf.length > 0) {
    label = node.anyOf.map(schemaTypeLabel).join(' | ')
  } else if (node.allOf.length > 0) {
    label = node.allOf.map(schemaTypeLabel).join(' & ')
  } else {
    label = 'any'
  }
  return node.nullable ? `${label} | null` : label
}

/** Texto JSON literal → texto para um campo simples (`"abc"` → `abc`, `10` → `10`). */
export function plainLiteral(literal: string): string {
  try {
    const value: unknown = JSON.parse(literal)
    return typeof value === 'string' ? value : literal
  } catch {
    return literal
  }
}

export interface ObjectProperty {
  name: string
  schema: SchemaNodeDto
  required: boolean
}

/**
 * Propriedades de um objeto, incluindo as herdadas de `allOf` e as de cada
 * variante de `oneOf`/`anyOf` (para sugestões, qualquer variante vale). A
 * primeira ocorrência de um nome vence.
 */
export function objectProperties(node: SchemaNodeDto, schemas: SchemaMap): ObjectProperty[] {
  const byName = new Map<string, ObjectProperty>()
  const visit = (current: SchemaNodeDto, depth: number) => {
    if (depth > MAX_COMPOSITION_DEPTH) return
    const resolved = resolveSchema(current, schemas)
    if (!resolved) return
    for (const property of resolved.properties) {
      if (!byName.has(property.name)) {
        byName.set(property.name, {
          name: property.name,
          schema: property.schema,
          required: resolved.required.includes(property.name),
        })
      }
    }
    for (const child of [...resolved.allOf, ...resolved.oneOf, ...resolved.anyOf]) visit(child, depth + 1)
  }
  visit(node, 0)
  return [...byName.values()]
}

/** Schema de um item de lista (`items`), olhando também dentro de composições. */
function arrayItems(node: SchemaNodeDto, schemas: SchemaMap, depth = 0): SchemaNodeDto | null {
  if (depth > MAX_COMPOSITION_DEPTH) return null
  const resolved = resolveSchema(node, schemas)
  if (!resolved) return null
  if (resolved.items) return resolved.items
  for (const child of [...resolved.allOf, ...resolved.oneOf, ...resolved.anyOf]) {
    const items = arrayItems(child, schemas, depth + 1)
    if (items) return items
  }
  return null
}

/** Segmento de caminho num documento JSON: nome de propriedade ou item de lista. */
export type JsonPathSegment = { kind: 'property'; name: string } | { kind: 'item' }

/** Schema no fim de `path`, a partir de `root`; `null` quando o caminho sai do schema. */
export function schemaAtPath(root: SchemaNodeDto, path: JsonPathSegment[], schemas: SchemaMap): SchemaNodeDto | null {
  let current: SchemaNodeDto | null = root
  for (const segment of path) {
    if (!current) return null
    if (segment.kind === 'item') {
      current = arrayItems(current, schemas)
      continue
    }
    const property = objectProperties(current, schemas).find((candidate) => candidate.name === segment.name)
    if (property) {
      current = property.schema
    } else {
      current = resolveSchema(current, schemas)?.additionalProperties ?? null
    }
  }
  return current
}

/** Tipos efetivos de um nó, olhando dentro das composições. */
export function schemaTypes(node: SchemaNodeDto, schemas: SchemaMap, depth = 0): Set<string> {
  const types = new Set<string>()
  if (depth > MAX_COMPOSITION_DEPTH) return types
  const resolved = resolveSchema(node, schemas)
  if (!resolved) return types
  for (const type of resolved.types) types.add(type)
  if (resolved.nullable) types.add('null')
  for (const child of [...resolved.allOf, ...resolved.oneOf, ...resolved.anyOf]) {
    for (const type of schemaTypes(child, schemas, depth + 1)) types.add(type)
  }
  return types
}

/**
 * Valores sugeridos (texto JSON literal, sem repetição): enum, `true`/`false`
 * para booleanos, `null` quando anulável, depois default e exemplos.
 */
export function valueLiterals(node: SchemaNodeDto | null, schemas: SchemaMap, extraExamples: (string | null)[] = []): string[] {
  const values: string[] = []
  const add = (literal: string | null | undefined) => {
    if (literal !== null && literal !== undefined && !values.includes(literal)) values.push(literal)
  }
  const resolved = node ? resolveSchema(node, schemas) : null
  if (node && resolved) {
    const collectEnums = (current: SchemaNodeDto, depth: number) => {
      const concrete = resolveSchema(current, schemas)
      if (!concrete || depth > MAX_COMPOSITION_DEPTH) return
      concrete.enumValues.forEach(add)
      for (const child of [...concrete.allOf, ...concrete.oneOf, ...concrete.anyOf]) collectEnums(child, depth + 1)
    }
    collectEnums(resolved, 0)
    const types = schemaTypes(resolved, schemas)
    if (types.has('boolean')) {
      add('true')
      add('false')
    }
    if (types.has('null')) add('null')
    add(resolved.default)
    add(resolved.example)
  }
  extraExamples.forEach(add)
  return values
}

export function parametersIn(docs: RequestDocsDto, location: ParameterLocation): ParameterDocDto[] {
  return docs.parameters.filter((parameter) => parameter.location === location)
}

/** Schema do corpo JSON: `application/json` (ou `+json`), senão o primeiro com schema. */
export function jsonBodySchema(docs: RequestDocsDto): SchemaNodeDto | null {
  const content = docs.requestBody?.content ?? []
  const json = content.find((media) => media.schema && /[/+]json\b/i.test(media.mediaType))
  return (json ?? content.find((media) => media.schema))?.schema ?? null
}

/** Linhas de enum/default/exemplo de um nó já resolvido, para exibição. */
export function schemaDetails(node: SchemaNodeDto, t: Translate): string[] {
  const details: string[] = []
  if (node.enumValues.length > 0) details.push(t('docs.enumValues', { values: node.enumValues.join(', ') }))
  if (node.default !== null) details.push(t('docs.defaultValue', { value: node.default }))
  if (node.example !== null) details.push(t('docs.exampleValue', { value: node.example }))
  return details
}
