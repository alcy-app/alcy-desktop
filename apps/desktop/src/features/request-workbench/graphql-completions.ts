import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Lexer, Source, TokenKind } from 'graphql'
import type { LoadSchemaOutput, SchemaField, SchemaType } from '../../bindings/load-schema'
import { completionTheme, floatingTooltips } from './codemirror-shared'
import { typeIndexOf } from './schema-helpers'

// ---------------------------------------------------------------------------
// Contexto do cursor numa query (tolerante a texto incompleto)
// ---------------------------------------------------------------------------

interface SelectionFrame {
  kind: 'selection'
  /** Tipo cujos campos podem ser selecionados aqui; `null` se desconhecido. */
  typeName: string | null
  /** Campos já selecionados neste nível, para não sugeri-los de novo. */
  selected: string[]
  /** Último campo lido, dono de um `(` ou `{` que vier em seguida. */
  pendingField: string | null
  /** `... on Tipo` lido, à espera do `{`. */
  pendingTypeCondition: string | null
}

interface ArgumentsFrame {
  kind: 'arguments'
  typeName: string | null
  fieldName: string
  used: string[]
  currentArg: string | null
  expectingValue: boolean
}

/** Definições de variáveis, argumentos de diretiva e valores lista/objeto: nada a sugerir. */
interface OtherFrame {
  kind: 'other'
}

type Frame = SelectionFrame | ArgumentsFrame | OtherFrame

export type GraphqlCursorContext =
  | { kind: 'document' }
  | { kind: 'field'; typeName: string | null; selected: string[] }
  | { kind: 'typeCondition'; typeName: string | null }
  | { kind: 'argument'; typeName: string | null; fieldName: string; used: string[] }
  | { kind: 'argumentValue'; typeName: string | null; fieldName: string; argName: string }

interface Token {
  kind: string
  value: string | undefined
}

const OPERATION_KEYWORDS = new Set(['query', 'mutation', 'subscription'])

function rootTypeFor(keyword: string, schema: LoadSchemaOutput): string | null {
  if (keyword === 'mutation') return schema.mutationType
  if (keyword === 'subscription') return schema.subscriptionType
  return schema.queryType
}

function fieldOf(types: Map<string, SchemaType>, typeName: string | null, fieldName: string): SchemaField | undefined {
  if (!typeName) return undefined
  return types.get(typeName)?.fields.find((field) => field.name === fieldName)
}

function lex(text: string): { tokens: Token[]; lastEnd: number } | null {
  const tokens: Token[] = []
  let lastEnd = 0
  try {
    const lexer = new Lexer(new Source(text))
    let token = lexer.advance()
    while (token.kind !== TokenKind.EOF) {
      tokens.push({ kind: token.kind, value: token.value })
      lastEnd = token.end
      token = lexer.advance()
    }
  } catch {
    // Texto inválido antes do cursor (ex.: string aberta): sem sugestões.
    return null
  }
  return { tokens, lastEnd }
}

/**
 * Onde o cursor está numa query possivelmente incompleta: escolhendo um
 * campo, a condição de tipo de um fragmento, o nome ou o valor de um
 * argumento. `text` é o documento até o início da palavra sendo digitada.
 * `null` quando não há o que sugerir (comentário, string, variáveis...).
 */
export function graphqlCursorContext(text: string, schema: LoadSchemaOutput): GraphqlCursorContext | null {
  const lexed = lex(text)
  if (!lexed) return null
  if (text.slice(lexed.lastEnd).includes('#')) return null

  const types = typeIndexOf(schema.types)
  const frames: Frame[] = []
  let documentRoot: string | null = null
  let awaitingFragmentType = false
  let aliasPending = false
  /** `... on` lido: o próximo nome é a condição de tipo. */
  let spreadOn = false
  let previous: Token | null = null
  let beforePrevious: Token | null = null

  for (const token of lexed.tokens) {
    const top = frames[frames.length - 1]
    const isName = token.kind === TokenKind.NAME
    const value = token.value ?? ''
    // `@nome(`: os parênteses são da diretiva, não do campo.
    const directiveArgs = previous?.kind === TokenKind.NAME && beforePrevious?.kind === TokenKind.AT

    if (token.kind === TokenKind.PAREN_L) {
      if (top?.kind === 'selection' && top.pendingField && !directiveArgs) {
        frames.push({
          kind: 'arguments',
          typeName: top.typeName,
          fieldName: top.pendingField,
          used: [],
          currentArg: null,
          expectingValue: false,
        })
      } else {
        frames.push({ kind: 'other' })
      }
    } else if (token.kind === TokenKind.BRACE_L) {
      if (!top) {
        frames.push({
          kind: 'selection',
          typeName: documentRoot ?? schema.queryType,
          selected: [],
          pendingField: null,
          pendingTypeCondition: null,
        })
        documentRoot = null
      } else if (top.kind === 'selection') {
        // `... {` (fragmento inline sem condição) continua no mesmo tipo.
        const childType = top.pendingTypeCondition
          ? top.pendingTypeCondition
          : top.pendingField
            ? (fieldOf(types, top.typeName, top.pendingField)?.typeName ?? null)
            : previous?.kind === TokenKind.SPREAD
              ? top.typeName
              : null
        top.pendingField = null
        top.pendingTypeCondition = null
        frames.push({ kind: 'selection', typeName: childType, selected: [], pendingField: null, pendingTypeCondition: null })
      } else {
        frames.push({ kind: 'other' })
      }
    } else if (token.kind === TokenKind.BRACKET_L) {
      frames.push({ kind: 'other' })
    } else if (
      token.kind === TokenKind.BRACE_R ||
      token.kind === TokenKind.PAREN_R ||
      token.kind === TokenKind.BRACKET_R
    ) {
      frames.pop()
      const parent = frames[frames.length - 1]
      if (parent?.kind === 'arguments') parent.expectingValue = false
      if (parent?.kind === 'selection' && token.kind === TokenKind.BRACE_R) parent.pendingField = null
    } else if (!top) {
      // Fora de qualquer chave: `query Nome(...)`, `fragment F on Tipo`.
      if (isName && OPERATION_KEYWORDS.has(value) && (previous === null || previous.kind === TokenKind.BRACE_R)) {
        documentRoot = rootTypeFor(value, schema)
      } else if (isName && value === 'fragment') {
        documentRoot = null
      } else if (isName && value === 'on') {
        awaitingFragmentType = true
      } else if (isName && awaitingFragmentType) {
        documentRoot = value
        awaitingFragmentType = false
      }
    } else if (top.kind === 'selection') {
      if (token.kind === TokenKind.COLON) {
        aliasPending = top.pendingField !== null
      } else if (isName && previous?.kind === TokenKind.SPREAD) {
        // `... on` (fragmento inline) ou `...NomeDoFragmento`.
        spreadOn = value === 'on'
        top.pendingField = null
      } else if (isName && spreadOn) {
        top.pendingTypeCondition = value
        spreadOn = false
      } else if (isName && previous?.kind === TokenKind.AT) {
        // Nome de diretiva.
      } else if (isName) {
        if (aliasPending && top.pendingField) top.selected.pop()
        top.pendingField = value
        top.selected.push(value)
        aliasPending = false
      }
    } else if (top.kind === 'arguments') {
      if (token.kind === TokenKind.COLON) {
        top.expectingValue = true
      } else if (isName && !top.expectingValue) {
        top.currentArg = value
        top.used.push(value)
      } else if (token.kind !== TokenKind.DOLLAR) {
        top.expectingValue = false
      }
    }
    beforePrevious = previous
    previous = token
  }

  const top = frames[frames.length - 1]
  if (!top) return previous === null || previous.kind === TokenKind.BRACE_R ? { kind: 'document' } : null
  if (top.kind === 'other') return null
  if (previous?.kind === TokenKind.AT || previous?.kind === TokenKind.DOLLAR) return null

  if (top.kind === 'selection') {
    if (spreadOn) return { kind: 'typeCondition', typeName: top.typeName }
    if (previous?.kind === TokenKind.SPREAD) return null
    return { kind: 'field', typeName: top.typeName, selected: top.selected }
  }

  if (top.expectingValue && top.currentArg) {
    return { kind: 'argumentValue', typeName: top.typeName, fieldName: top.fieldName, argName: top.currentArg }
  }
  if (!top.expectingValue) return { kind: 'argument', typeName: top.typeName, fieldName: top.fieldName, used: top.used }
  return null
}

// ---------------------------------------------------------------------------
// Sugestões a partir do schema
// ---------------------------------------------------------------------------

export interface GraphqlCompletionOption {
  label: string
  apply: string
  detail?: string
  info?: string
  boost?: number
  type: 'property' | 'keyword' | 'type' | 'enum' | 'variable'
}

export interface GraphqlCompletions {
  from: number
  options: GraphqlCompletionOption[]
}

const WORD_BEFORE = /[_A-Za-z][_0-9A-Za-z]*$/

function fieldOptions(type: SchemaType, selected: string[]): GraphqlCompletionOption[] {
  const options: GraphqlCompletionOption[] = type.fields
    .filter((field) => !selected.includes(field.name))
    .map((field) => ({
      label: field.name,
      apply: field.name,
      detail: field.typeDisplay,
      info: field.description ?? undefined,
      // Campos depreciados vão para o fim da lista.
      boost: field.isDeprecated ? -1 : 0,
      type: 'property',
    }))
  if (!selected.includes('__typename')) {
    options.push({ label: '__typename', apply: '__typename', detail: 'String!', boost: -2, type: 'property' })
  }
  return options
}

function typeConditionOptions(type: SchemaType | undefined, types: SchemaType[]): GraphqlCompletionOption[] {
  const names =
    type && type.possibleTypes.length > 0
      ? type.possibleTypes
      : types
          .filter((candidate) => candidate.kind === 'OBJECT' || candidate.kind === 'INTERFACE' || candidate.kind === 'UNION')
          .filter((candidate) => !candidate.name.startsWith('__'))
          .map((candidate) => candidate.name)
  return names.map((name) => ({ label: name, apply: name, type: 'type' }))
}

/**
 * Sugestões para a posição `pos` de uma query: campos do tipo atual (e
 * fragmentos `... on` em unions/interfaces), condições de tipo, nomes de
 * argumentos ainda não usados e valores de enum/booleano. Sem texto digitado
 * e sem pedido explícito (`explicit`), só abre logo depois de `{`, `(` ou `:`.
 */
export function graphqlCompletions(
  text: string,
  pos: number,
  schema: LoadSchemaOutput,
  explicit: boolean,
): GraphqlCompletions | null {
  const before = text.slice(0, pos)
  // `{{variável}}` aberto: quem sugere é o autocompletar de variáveis.
  if (/\{\{[^{}\n]*$/.test(before)) return null

  const word = WORD_BEFORE.exec(before)?.[0] ?? ''
  const from = pos - word.length
  // Variáveis (`$id`) e diretivas (`@include`) não vêm do schema de tipos.
  if (/[$@]$/.test(text.slice(0, from))) return null
  if (!word && !explicit && !/[{(:]\s*$/.test(before) && !/\bon\s+$/.test(before)) return null

  const context = graphqlCursorContext(text.slice(0, from), schema)
  if (!context) return null

  const types = typeIndexOf(schema.types)
  let options: GraphqlCompletionOption[] = []

  if (context.kind === 'document') {
    options = ['query', 'mutation', 'subscription', 'fragment'].map((keyword) => ({
      label: keyword,
      apply: keyword,
      type: 'keyword',
    }))
  } else if (context.kind === 'field') {
    const type = context.typeName ? types.get(context.typeName) : undefined
    if (!type) return null
    options = fieldOptions(type, context.selected)
    if (type.kind === 'UNION' || type.kind === 'INTERFACE') {
      options.push(
        ...type.possibleTypes.map((name): GraphqlCompletionOption => ({
          label: `... on ${name}`,
          apply: `... on ${name} `,
          type: 'type',
        })),
      )
    }
  } else if (context.kind === 'typeCondition') {
    options = typeConditionOptions(context.typeName ? types.get(context.typeName) : undefined, schema.types)
  } else if (context.kind === 'argument') {
    const field = fieldOf(types, context.typeName, context.fieldName)
    options = (field?.args ?? [])
      .filter((arg) => !context.used.includes(arg.name))
      .map((arg) => ({
        label: arg.name,
        apply: `${arg.name}: `,
        detail: arg.typeDisplay,
        info: arg.description ?? undefined,
        // Argumentos obrigatórios primeiro.
        boost: arg.typeDisplay.endsWith('!') ? 1 : 0,
        type: 'property',
      }))
  } else {
    const arg = fieldOf(types, context.typeName, context.fieldName)?.args.find((candidate) => candidate.name === context.argName)
    const argType = arg?.typeName ? types.get(arg.typeName) : undefined
    if (argType?.kind === 'ENUM') {
      options = argType.enumValues.map((value) => ({
        label: value.name,
        apply: value.name,
        info: value.description ?? undefined,
        boost: value.isDeprecated ? -1 : 0,
        type: 'enum',
      }))
    } else if (arg?.typeName === 'Boolean') {
      options = ['true', 'false'].map((value) => ({ label: value, apply: value, type: 'keyword' }))
    }
  }

  return options.length > 0 ? { from, options } : null
}

// ---------------------------------------------------------------------------
// Extensão do CodeMirror
// ---------------------------------------------------------------------------

/** Troca o schema usado pelas sugestões da query (`null` desliga). */
export const setQuerySchema = StateEffect.define<LoadSchemaOutput | null>()

const querySchemaField = StateField.define<LoadSchemaOutput | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setQuerySchema)) return effect.value
    return value
  },
})

function graphqlCompletionSource(context: CompletionContext): CompletionResult | null {
  const schema = context.state.field(querySchemaField, false)
  if (!schema) return null
  const result = graphqlCompletions(context.state.doc.toString(), context.pos, schema, context.explicit)
  if (!result) return null
  const options: Completion[] = result.options.map((option) => ({ ...option }))
  return { from: result.from, options, validFor: /^\w*$/ }
}

const graphqlCompletionLanguageData = [{ autocomplete: graphqlCompletionSource }]

/** Sugestões de campos, argumentos e valores da query a partir do schema
 * carregado. O schema chega por `setQuerySchema`; sem ele, nada é sugerido.
 * As teclas para aceitar vêm de `completionShortcutsExtension`. */
export function graphqlCompletionExtension(): Extension {
  return [
    querySchemaField,
    EditorState.languageData.of(() => graphqlCompletionLanguageData),
    completionTheme,
    floatingTooltips(),
  ]
}
