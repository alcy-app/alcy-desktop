import { Lexer, Source, TokenKind } from 'graphql'

export type GraphqlTokenType = 'keyword' | 'name' | 'punctuation' | 'string' | 'number' | 'variable' | 'comment' | 'plain'

export interface GraphqlToken {
  type: GraphqlTokenType
  text: string
}

const KEYWORDS = new Set(['query', 'mutation', 'subscription', 'fragment', 'on', 'true', 'false', 'null'])

const COMMENT_PATTERN = /#[^\n]*/g

/** Trechos que o lexer pula por completo (espaços, vírgulas, comentários) — separa só os comentários do resto. */
function tokenizeGap(text: string): GraphqlToken[] {
  const tokens: GraphqlToken[] = []
  let cursor = 0
  for (const match of text.matchAll(COMMENT_PATTERN)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ type: 'plain', text: text.slice(cursor, index) })
    tokens.push({ type: 'comment', text: match[0] })
    cursor = index + match[0].length
  }
  if (cursor < text.length) tokens.push({ type: 'plain', text: text.slice(cursor) })
  return tokens
}

function classify(kind: string, value: string | undefined, previousKind: string | null): GraphqlTokenType {
  switch (kind) {
    case TokenKind.NAME:
      if (previousKind === TokenKind.DOLLAR) return 'variable'
      return value && KEYWORDS.has(value) ? 'keyword' : 'name'
    case TokenKind.INT:
    case TokenKind.FLOAT:
      return 'number'
    case TokenKind.STRING:
    case TokenKind.BLOCK_STRING:
      return 'string'
    default:
      return 'punctuation'
  }
}

/**
 * Tokeniza uma query GraphQL para colorir sua sintaxe no overlay do editor.
 * Tolerante a texto inválido ou incompleto (comum enquanto o usuário digita):
 * ao encontrar um erro léxico, para a tokenização e devolve o restante do
 * texto como texto simples, em vez de quebrar o destaque inteiro. Nunca
 * descarta caracteres — a soma dos tokens sempre reconstrói `source`
 * exatamente, o que o overlay exige para ficar alinhado ao textarea real.
 */
export function tokenizeGraphql(source: string): GraphqlToken[] {
  if (source.length === 0) return []

  const tokens: GraphqlToken[] = []
  let cursor = 0
  let previousKind: string | null = null

  try {
    const lexer = new Lexer(new Source(source))
    let token = lexer.advance()
    while (token.kind !== TokenKind.EOF) {
      if (token.start > cursor) tokens.push(...tokenizeGap(source.slice(cursor, token.start)))
      tokens.push({ type: classify(token.kind, token.value, previousKind), text: source.slice(token.start, token.end) })
      previousKind = token.kind
      cursor = token.end
      token = lexer.advance()
    }
  } catch {
    // Segue com o que já foi tokenizado — o restante cai no trecho final abaixo.
  }

  if (cursor < source.length) tokens.push(...tokenizeGap(source.slice(cursor)))

  return tokens
}
