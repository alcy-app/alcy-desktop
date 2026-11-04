import { StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import type { Translate } from './template-highlight'
import { tokenizeGraphql } from './graphql-syntax-highlight'
import type { GraphqlTokenType } from './graphql-syntax-highlight'
import {
  setEnvironmentVariables,
  type GetVariableEditing,
  variableHoverTooltip,
  variableRangesFor,
  variableTokenDecorations,
  variablesField,
} from './template-variables-codemirror'

const GQL_TOKEN_CLASS_NAME: Partial<Record<GraphqlTokenType, string>> = {
  keyword: 'gql-token gql-token--keyword',
  string: 'gql-token gql-token--string',
  number: 'gql-token gql-token--number',
  variable: 'gql-token gql-token--variable',
  punctuation: 'gql-token gql-token--punctuation',
  comment: 'gql-token gql-token--comment',
}

export const setQueryVariables = setEnvironmentVariables

/**
 * Syntax marks only. A `{{variable}}` token always gets the variable color,
 * even inside a colored GraphQL token (typically a string), so the syntax
 * marks are clipped around variable ranges instead of overlapping them; the
 * variable chips themselves come from `variableTokenDecorations`.
 */
function buildDecorations(doc: string, variables: EnvironmentVariableDto[]): DecorationSet {
  const variableRanges = variableRangesFor(doc, variables)
  const marks: { from: number; to: number; className: string }[] = []

  let tokenStart = 0
  for (const token of tokenizeGraphql(doc)) {
    const tokenEnd = tokenStart + token.text.length
    const className = GQL_TOKEN_CLASS_NAME[token.type]
    if (className) {
      let cursor = tokenStart
      for (const variable of variableRanges) {
        if (variable.to <= cursor || variable.from >= tokenEnd) continue
        const clipStart = Math.max(variable.from, cursor)
        if (clipStart > cursor) marks.push({ from: cursor, to: clipStart, className })
        cursor = Math.max(cursor, Math.min(variable.to, tokenEnd))
      }
      if (cursor < tokenEnd) marks.push({ from: cursor, to: tokenEnd, className })
    }
    tokenStart = tokenEnd
  }

  return Decoration.set(
    marks.map((mark) => Decoration.mark({ class: mark.className }).range(mark.from, mark.to)),
    true,
  )
}

const decorationsField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state.doc.toString(), state.field(variablesField)),
  update: (value, tr) => {
    if (tr.docChanged || tr.effects.some((effect) => effect.is(setEnvironmentVariables))) {
      return buildDecorations(tr.state.doc.toString(), tr.state.field(variablesField))
    }
    return value.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** Destaque de sintaxe GraphQL + templates `{{variável}}` (com tooltip ao passar o mouse) para o editor de query, sobre CodeMirror 6. */
export function graphqlQueryHighlight(getTranslate: () => Translate, getEditing?: GetVariableEditing) {
  return [variablesField, variableTokenDecorations, decorationsField, variableHoverTooltip(getTranslate, getEditing)]
}
