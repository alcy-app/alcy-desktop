import { autocompletion, pickedCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { IndentContext, getIndentUnit, getIndentation, indentString } from '@codemirror/language'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ParameterDocDto, SchemaNodeDto } from '../../bindings/get-request-docs'
import { floatingTooltips } from './codemirror-shared'
import {
  objectProperties,
  plainLiteral,
  resolveSchema,
  schemaAtPath,
  schemaTypeLabel,
  valueLiterals,
} from './schema-docs'
import type { JsonPathSegment, SchemaMap } from './schema-docs'

// ---------------------------------------------------------------------------
// Contexto do cursor num documento JSON (tolerante a texto incompleto)
// ---------------------------------------------------------------------------

interface ObjectFrame {
  kind: 'object'
  /** Segmento que leva do container pai até este. */
  segment: JsonPathSegment | null
  state: 'key' | 'colon' | 'value' | 'comma'
  key: string | null
  keys: string[]
}

interface ArrayFrame {
  kind: 'array'
  segment: JsonPathSegment | null
  state: 'value' | 'comma'
}

type Frame = ObjectFrame | ArrayFrame

export type JsonCursorContext =
  | {
      kind: 'key'
      /** Caminho até o objeto cujas chaves estão sendo digitadas. */
      path: JsonPathSegment[]
      existingKeys: string[]
      /** Início do texto digitado (depois da aspa, se houver). */
      from: number
      /** Fim do trecho substituído (inclui a aspa de fechamento, se existir). */
      to: number
      quoted: boolean
    }
  | { kind: 'value'; path: JsonPathSegment[]; from: number; to: number; quoted: boolean }

const WORD_CHAR = /[\w.+-]/

function segmentForChild(parent: Frame | undefined): JsonPathSegment | null {
  if (!parent) return null
  if (parent.kind === 'array') return { kind: 'item' }
  return parent.key === null ? null : { kind: 'property', name: parent.key }
}

function afterValue(frame: Frame | undefined) {
  if (frame) frame.state = 'comma'
}

function pathOf(frames: Frame[]): JsonPathSegment[] | null {
  const path: JsonPathSegment[] = []
  for (const frame of frames.slice(1)) {
    if (!frame.segment) return null
    path.push(frame.segment)
  }
  return path
}

/**
 * Onde o cursor está num JSON possivelmente incompleto: digitando uma chave
 * de objeto ou um valor. Referências `{{variável}}` fora de strings contam
 * como valor. `null` quando não há o que sugerir (ex.: depois de um valor).
 */
export function jsonCursorContext(text: string, pos: number): JsonCursorContext | null {
  const frames: Frame[] = []
  let index = 0
  let openString: number | null = null

  while (index < pos) {
    const char = text[index]
    const top = frames[frames.length - 1]
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      if (end >= pos) {
        openString = index
        break
      }
      const content = text.slice(index + 1, end)
      if (top?.kind === 'object' && top.state === 'key') {
        top.key = content
        top.keys.push(content)
        top.state = 'colon'
      } else {
        afterValue(top)
      }
      index = end + 1
      continue
    }
    if (char === '{' && text[index + 1] === '{') {
      const close = text.indexOf('}}', index + 2)
      if (close === -1 || close + 2 > pos) return null
      afterValue(top)
      index = close + 2
      continue
    }
    if (char === '{' || char === '[') {
      const segment = segmentForChild(top)
      frames.push(
        char === '{'
          ? { kind: 'object', segment, state: 'key', key: null, keys: [] }
          : { kind: 'array', segment, state: 'value' },
      )
      index += 1
      continue
    }
    if (char === '}' || char === ']') {
      frames.pop()
      afterValue(frames[frames.length - 1])
      index += 1
      continue
    }
    if (char === ':') {
      if (top?.kind === 'object') top.state = 'value'
      index += 1
      continue
    }
    if (char === ',') {
      if (top?.kind === 'object') {
        top.state = 'key'
        top.key = null
      } else if (top) {
        top.state = 'value'
      }
      index += 1
      continue
    }
    if (WORD_CHAR.test(char)) {
      let end = index
      while (end < text.length && WORD_CHAR.test(text[end])) end += 1
      if (end >= pos) break
      afterValue(top)
      index = end
      continue
    }
    index += 1
  }

  const top = frames[frames.length - 1]
  if (!top) return null
  const containerPath = pathOf(frames)
  if (!containerPath) return null

  let from: number
  let to = pos
  const quoted = openString !== null
  if (openString !== null) {
    from = openString + 1
    if (text[pos] === '"') to = pos + 1
  } else {
    from = pos
    while (from > 0 && WORD_CHAR.test(text[from - 1])) from -= 1
  }

  if (top.kind === 'object' && top.state === 'key') {
    return { kind: 'key', path: containerPath, existingKeys: top.keys, from, to, quoted }
  }
  if (top.kind === 'object' && top.state === 'value' && top.key !== null) {
    return { kind: 'value', path: [...containerPath, { kind: 'property', name: top.key }], from, to, quoted }
  }
  if (top.kind === 'array' && top.state === 'value') {
    return { kind: 'value', path: [...containerPath, { kind: 'item' }], from, to, quoted }
  }
  return null
}

// ---------------------------------------------------------------------------
// Sugestões de corpo JSON a partir do schema
// ---------------------------------------------------------------------------

export interface BodySchema {
  root: SchemaNodeDto
  schemas: SchemaMap
}

export interface SchemaCompletion {
  label: string
  apply: string
  detail?: string
  info?: string
  boost?: number
}

export interface SchemaCompletions {
  from: number
  to: number
  /** Onde começa a chave sendo completada (a aspa de abertura, se houver);
   * ausente quando o cursor está num valor. */
  keyStart?: number
  options: SchemaCompletion[]
}

export function jsonSchemaCompletions(text: string, pos: number, body: BodySchema): SchemaCompletions | null {
  const context = jsonCursorContext(text, pos)
  if (!context) return null
  const node = schemaAtPath(body.root, context.path, body.schemas)
  if (!node) return null

  if (context.kind === 'key') {
    const options = objectProperties(node, body.schemas)
      .filter((property) => !context.existingKeys.includes(property.name))
      .map((property): SchemaCompletion => {
        const resolved = resolveSchema(property.schema, body.schemas)
        const description = property.schema.description || resolved?.description || ''
        return {
          label: property.name,
          apply: context.quoted ? `${property.name}": ` : `"${property.name}": `,
          detail: schemaTypeLabel(property.schema) + (property.required ? ' *' : ''),
          info: description || undefined,
          boost: property.required ? 1 : 0,
        }
      })
    if (options.length === 0) return null
    return { from: context.from, to: context.to, keyStart: context.quoted ? context.from - 1 : context.from, options }
  }

  const literals = valueLiterals(node, body.schemas)
  const options = context.quoted
    ? literals
        .filter((literal) => literal.startsWith('"'))
        .map((literal): SchemaCompletion => {
          const value = plainLiteral(literal)
          return { label: value, apply: `${value}"` }
        })
    : literals.map((literal): SchemaCompletion => ({ label: literal, apply: literal }))
  return options.length > 0 ? { from: context.from, to: context.to, options } : null
}

/**
 * Aceita uma chave sugerida. Numa linha que já tem conteúdo antes dela (logo
 * depois de `{` ou `,`), a chave vai para a linha seguinte, indentada como o
 * Enter indentaria; um `}` logo depois dela desce para uma linha própria.
 * Numa linha vazia, só substitui o texto digitado.
 */
export function applyJsonKey(name: string, keyStart: number) {
  return (view: EditorView, completion: Completion, _from: number, to: number) => {
    const { state } = view
    const line = state.doc.lineAt(keyStart)
    const before = state.sliceDoc(line.from, keyStart)
    const key = `"${name}": `
    const pick = { scrollIntoView: true, userEvent: 'input.complete', annotations: pickedCompletion.of(completion) }
    if (before.trim() === '') {
      view.dispatch({ changes: { from: keyStart, to, insert: key }, selection: { anchor: keyStart + key.length }, ...pick })
      return
    }

    // Espaços entre o `{`/`,` e a chave não ficam sobrando no fim da linha.
    const breakAt = keyStart - (before.length - before.trimEnd().length)
    const closing = /^\s*\}/.exec(state.sliceDoc(to, line.to))
    const lineIndent = /^\s*/.exec(line.text)?.[0] ?? ''
    const context = new IndentContext(state, { simulateBreak: breakAt, simulateDoubleBreak: closing !== null })
    const columns = getIndentation(context, breakAt) ?? lineIndent.length + getIndentUnit(state)
    const head = `\n${indentString(state, columns)}${key}`
    const tail = closing ? `\n${lineIndent}` : ''
    view.dispatch({
      changes: { from: breakAt, to: closing ? to + closing[0].length - 1 : to, insert: head + tail },
      selection: { anchor: breakAt + head.length },
      ...pick,
    })
  }
}

/** Troca o schema do corpo usado pelas sugestões (`null` desliga). */
export const setBodySchema = StateEffect.define<BodySchema | null>()

const bodySchemaField = StateField.define<BodySchema | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBodySchema)) return effect.value
    return value
  },
})

function bodySchemaCompletionSource(context: CompletionContext): CompletionResult | null {
  const body = context.state.field(bodySchemaField, false)
  if (!body) return null
  const result = jsonSchemaCompletions(context.state.doc.toString(), context.pos, body)
  if (!result) return null
  // Sem texto digitado, só abre a lista quando pedida (Ctrl+Espaço) ou logo
  // depois de `{`, `,`, `:`, `[` ou aspas — não a cada espaço em branco.
  if (result.from === context.pos && !context.explicit) {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos)
    if (!/[{,:["\s]/.test(before)) return null
  }
  const { keyStart } = result
  const options: Completion[] = result.options.map((option) => ({
    label: option.label,
    apply: keyStart === undefined ? option.apply : applyJsonKey(option.label, keyStart),
    detail: option.detail,
    info: option.info,
    boost: option.boost,
    type: 'property',
  }))
  return { from: result.from, to: result.to, options, validFor: /^[\w.+-]*$/ }
}

const bodySchemaLanguageData = [{ autocomplete: bodySchemaCompletionSource }]

/** Sugestões de chaves e valores do corpo JSON a partir do schema importado
 * (ADR 0035). O schema chega por `setBodySchema`; sem ele, nada é sugerido. */
export function bodySchemaExtension(): Extension {
  return [
    bodySchemaField,
    autocompletion({ icons: false }),
    EditorState.languageData.of(() => bodySchemaLanguageData),
    floatingTooltips(),
  ]
}

// ---------------------------------------------------------------------------
// Sugestões para as grids de Params e Headers
// ---------------------------------------------------------------------------

/** Sugestão de um campo de texto simples (nome ou valor de parâmetro/header). */
export interface FieldSuggestion {
  value: string
  detail?: string
  description?: string
}

/** Nomes documentados ainda não usados na grid (obrigatórios primeiro).
 * Headers comparam sem diferenciar maiúsculas. */
export function parameterNameSuggestions(
  parameters: ParameterDocDto[],
  usedNames: string[],
  caseInsensitive = false,
): FieldSuggestion[] {
  const normalize = (name: string) => (caseInsensitive ? name.toLowerCase() : name)
  const used = new Set(usedNames.map(normalize))
  return parameters
    .filter((parameter) => !used.has(normalize(parameter.name)))
    .sort((a, b) => Number(b.required) - Number(a.required))
    .map((parameter) => ({
      value: parameter.name,
      detail: [parameter.schema ? schemaTypeLabel(parameter.schema) : null, parameter.required ? '*' : null]
        .filter(Boolean)
        .join(' ') || undefined,
      description: parameter.description || undefined,
    }))
}

/** Valores conhecidos do parâmetro `name` (enum, booleanos, default, exemplo). */
export function parameterValueSuggestions(
  parameters: ParameterDocDto[],
  name: string,
  schemas: SchemaMap,
  caseInsensitive = false,
): FieldSuggestion[] {
  const target = caseInsensitive ? name.toLowerCase() : name
  const parameter = parameters.find(
    (candidate) => (caseInsensitive ? candidate.name.toLowerCase() : candidate.name) === target,
  )
  if (!parameter) return []
  return valueLiterals(parameter.schema, schemas, [parameter.example]).map((literal) => ({ value: plainLiteral(literal) }))
}
