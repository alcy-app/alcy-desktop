export type OperationType = 'query' | 'mutation' | 'subscription'

interface BraceRange {
  openEnd: number
  closeStart: number
}

/** Posição de um trecho completo (ex.: `(a: 1)`) na fonte original, para substituição cirúrgica. */
interface Span {
  start: number
  end: number
}

export interface FieldSelectionNode {
  kind: 'field'
  name: string
  /** Texto bruto dos argumentos, incluindo os parênteses (ex.: '(id: "1")'). Vazio se não houver. */
  args: string
  /** Posição exata dos parênteses de `args` na fonte original, para edição cirúrgica. `null` se não houver. */
  argsRange: Span | null
  /** Posição do primeiro caractere do nome, na fonte original. */
  start: number
  /** Posição logo após o fim do campo (após `}` se houver filhos, senão após args/nome). */
  end: number
  /** `null` = campo folha, sem chaves. `[]` = campo com chaves vazias `{ }`. */
  children: SelectionNode[] | null
  childrenRange: BraceRange | null
}

/** `...NomeDoFragmento` — opaco: nunca é adicionado/removido pela UI, só preservado ao editar campos ao redor. */
export interface FragmentSpreadNode {
  kind: 'fragmentSpread'
  name: string
  start: number
  end: number
}

export type SelectionNode = FieldSelectionNode | FragmentSpreadNode

export interface ParsedQuery {
  /** Texto original de onde esta árvore foi extraída — base para as edições cirúrgicas de `toggleField`. */
  source: string
  operationType: OperationType
  operationName: string
  selections: SelectionNode[]
  rootRange: BraceRange
}

export function createEmptyQuery(): ParsedQuery {
  return {
    source: '',
    operationType: 'query',
    operationName: '',
    selections: [],
    rootRange: { openEnd: 0, closeStart: 0 },
  }
}

class Scanner {
  pos = 0
  private readonly source: string

  constructor(source: string) {
    this.source = source
  }

  get length(): number {
    return this.source.length
  }

  peek(): string | undefined {
    return this.source[this.pos]
  }

  /** Ignora espaços, vírgulas e comentários `#` até fim de linha — nunca é um erro de sintaxe. */
  skipIgnored(): void {
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos]
      if (ch === '#') {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n') this.pos++
        continue
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos++
        continue
      }
      break
    }
  }

  readName(): string | null {
    this.skipIgnored()
    const start = this.pos
    while (this.pos < this.source.length && /[A-Za-z0-9_]/.test(this.source[this.pos])) this.pos++
    if (this.pos === start) return null
    return this.source.slice(start, this.pos)
  }

  /** Lê texto balanceado a partir de `open` (posição atual) até o `close` correspondente, ignorando chaves/parênteses dentro de strings entre aspas. */
  readBalanced(open: string, close: string): string {
    const start = this.pos
    let depth = 0
    let inString = false
    for (; this.pos < this.source.length; this.pos++) {
      const ch = this.source[this.pos]
      if (inString) {
        if (ch === '\\') {
          this.pos++
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
      } else if (ch === open) {
        depth++
      } else if (ch === close) {
        depth--
        if (depth === 0) {
          this.pos++
          return this.source.slice(start, this.pos)
        }
      }
    }
    throw new Error('unbalanced')
  }
}

function parseSelectionSet(scanner: Scanner): { selections: SelectionNode[]; range: BraceRange } {
  scanner.skipIgnored()
  if (scanner.peek() !== '{') throw new Error('expected {')
  scanner.pos++
  const openEnd = scanner.pos

  const selections: SelectionNode[] = []
  while (true) {
    scanner.skipIgnored()
    if (scanner.peek() === '}') {
      const closeStart = scanner.pos
      scanner.pos++
      return { selections, range: { openEnd, closeStart } }
    }
    if (scanner.pos >= scanner.length) throw new Error('unexpected end of input')

    if (scanner.peek() === '.') {
      selections.push(parseFragmentSpread(scanner))
    } else {
      selections.push(parseField(scanner))
    }
  }
}

function parseFragmentSpread(scanner: Scanner): FragmentSpreadNode {
  scanner.skipIgnored()
  const start = scanner.pos
  for (let i = 0; i < 3; i++) {
    if (scanner.peek() !== '.') throw new Error('expected ...')
    scanner.pos++
  }
  const name = scanner.readName()
  // "... on Type { }" é um fragmento inline — não suportado, desiste do parsing inteiro.
  if (!name || name === 'on') throw new Error('inline fragments are not supported')
  return { kind: 'fragmentSpread', name, start, end: scanner.pos }
}

function parseField(scanner: Scanner): FieldSelectionNode {
  scanner.skipIgnored()
  const start = scanner.pos
  const name = scanner.readName()
  if (!name) throw new Error('expected a field name')
  let end = scanner.pos

  // `skipIgnored` sempre avança — se não achar `(` ou `{` na sequência,
  // desfaz o avanço para não incluir espaço/comentário à toa em `end`
  // (isso viraria uma remoção incompleta em `toggleField`, deixando lixo
  // de formatação para trás).
  const beforeArgs = scanner.pos
  scanner.skipIgnored()
  let args = ''
  let argsRange: Span | null = null
  if (scanner.peek() === '(') {
    const argsStart = scanner.pos
    args = scanner.readBalanced('(', ')')
    end = scanner.pos
    argsRange = { start: argsStart, end }
  } else {
    scanner.pos = beforeArgs
  }

  const beforeChildren = scanner.pos
  scanner.skipIgnored()
  let children: SelectionNode[] | null = null
  let childrenRange: BraceRange | null = null
  if (scanner.peek() === '{') {
    const parsed = parseSelectionSet(scanner)
    children = parsed.selections
    childrenRange = parsed.range
    end = scanner.pos
  } else {
    scanner.pos = beforeChildren
  }

  return { kind: 'field', name, args, argsRange, start, end, children, childrenRange }
}

/**
 * Valida (sem interpretar o conteúdo) que o que sobrou após a seleção raiz
 * são só definições de fragmento (`fragment Nome on Tipo { ... }`) — opacas,
 * preservadas verbatim em `source` já que as edições nunca as tocam.
 * Qualquer outra coisa faz `parseQuery` desistir (retorna `null`).
 */
function validateTrailingFragments(scanner: Scanner): boolean {
  while (true) {
    scanner.skipIgnored()
    if (scanner.pos >= scanner.length) return true

    if (scanner.readName() !== 'fragment') return false
    if (!scanner.readName()) return false
    if (scanner.readName() !== 'on') return false
    if (!scanner.readName()) return false

    scanner.skipIgnored()
    if (scanner.peek() !== '{') return false
    try {
      parseSelectionSet(scanner)
    } catch {
      return false
    }
  }
}

/**
 * Interpreta uma query GraphQL simples num formato editável em árvore, com
 * posições na fonte original para permitir edição cirúrgica (`toggleField`)
 * em vez de reimprimir tudo — o que preservaria formatação/comentários do
 * usuário fora do ponto exato editado.
 *
 * Suporta: comentários `#`, variáveis de operação (preservadas como texto
 * opaco) e fragment spreads (`...Nome`, preservados, nunca adicionados pela
 * UI). Não suporta fragmentos inline (`... on Tipo`) nem diretivas — ao
 * encontrar qualquer um desses, ou texto sobrando que não seja definição de
 * fragmento, retorna `null` em vez de arriscar corromper a query.
 */
export function parseQuery(source: string): ParsedQuery | null {
  try {
    const scanner = new Scanner(source)
    scanner.skipIgnored()

    let operationType: OperationType = 'query'
    let operationName = ''

    if (scanner.peek() !== '{') {
      const keyword = scanner.readName()
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') return null
      operationType = keyword

      scanner.skipIgnored()
      if (scanner.peek() !== '{' && scanner.peek() !== '(') {
        operationName = scanner.readName() ?? ''
      }

      scanner.skipIgnored()
      if (scanner.peek() === '(') {
        // Variáveis de operação: preservadas por estarem antes da seleção
        // raiz, fora do alcance de qualquer edição de campo — não precisam
        // ser guardadas à parte, `source` já as contém.
        scanner.readBalanced('(', ')')
      }
    }

    const { selections, range } = parseSelectionSet(scanner)

    if (!validateTrailingFragments(scanner)) return null

    return { source, operationType, operationName, selections, rootRange: range }
  } catch {
    return null
  }
}

function selectionsAtPath(selections: SelectionNode[], path: string[]): SelectionNode[] {
  if (path.length === 0) return selections
  const [head, ...rest] = path
  const match = selections.find((selection): selection is FieldSelectionNode => selection.kind === 'field' && selection.name === head)
  if (!match || match.children === null) return []
  return selectionsAtPath(match.children, rest)
}

export function isFieldSelected(parsed: ParsedQuery, path: string[], fieldName: string): boolean {
  return selectionsAtPath(parsed.selections, path).some((selection) => selection.kind === 'field' && selection.name === fieldName)
}

interface Container {
  selections: SelectionNode[]
  range: BraceRange
}

function resolveContainer(parsed: ParsedQuery, path: string[]): Container | null {
  let selections = parsed.selections
  let range = parsed.rootRange
  for (const segment of path) {
    const match = selections.find((selection): selection is FieldSelectionNode => selection.kind === 'field' && selection.name === segment)
    if (!match || match.children === null || !match.childrenRange) return null
    selections = match.children
    range = match.childrenRange
  }
  return { selections, range }
}

function spliceSource(source: string, start: number, end: number, replacement: string): string {
  return source.slice(0, start) + replacement + source.slice(end)
}

/** Indentação (espaços/tabs) da linha que contém `position`. */
function lineIndent(source: string, position: number): string {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  const match = /^[ \t]*/.exec(source.slice(lineStart))
  return match ? match[0] : ''
}

function addField(source: string, container: Container, fieldName: string, hasSubfields: boolean): string {
  const snippet = hasSubfields ? `${fieldName} {}` : fieldName
  const isEmpty = source.slice(container.range.openEnd, container.range.closeStart).trim().length === 0

  const closingIndent = lineIndent(source, container.range.closeStart)
  const childIndent = `${closingIndent}  `

  if (isEmpty) {
    const insertion = `\n${childIndent}${snippet}\n${closingIndent}`
    return spliceSource(source, container.range.openEnd, container.range.closeStart, insertion)
  }

  const lastChild = container.selections[container.selections.length - 1]
  const insertion = `\n${childIndent}${snippet}`
  return spliceSource(source, lastChild.end, lastChild.end, insertion)
}

function removeField(source: string, container: Container, node: SelectionNode): string {
  if (container.selections.length === 1) {
    // Único filho: colapsa o bloco inteiro de volta a chaves vazias.
    return spliceSource(source, container.range.openEnd, container.range.closeStart, '')
  }

  const index = container.selections.indexOf(node)
  const precedingBoundary = index === 0 ? container.range.openEnd : container.selections[index - 1].end
  return spliceSource(source, precedingBoundary, node.end, '')
}

/**
 * Adiciona `fieldName` em `path` se ainda não estiver selecionado, ou
 * remove (com toda a sua subárvore) se já estiver — nunca duplica.
 *
 * Edita `parsed.source` cirurgicamente (insere/remove só o span exato do
 * campo), em vez de reimprimir a árvore inteira — preserva formatação e
 * comentários do resto da query. `path` deve levar a um campo já
 * selecionado (ou estar vazio, a raiz da operação); um caminho para um
 * campo que não existe mais na seleção é ignorado, devolvendo a query
 * inalterada.
 *
 * Devolve o novo texto completo da query (não uma `ParsedQuery` — quem
 * chama re-interpreta a string atualizada quando precisar da árvore de
 * novo, ex. para o próximo clique).
 */
export function toggleField(parsed: ParsedQuery, path: string[], fieldName: string, hasSubfields: boolean): string {
  if (parsed.source.trim().length === 0) {
    const snippet = hasSubfields ? `${fieldName} {}` : fieldName
    return `{\n  ${snippet}\n}`
  }

  const container = resolveContainer(parsed, path)
  if (!container) return parsed.source

  const existing = container.selections.find((selection) => selection.kind === 'field' && selection.name === fieldName)

  if (existing) {
    return removeField(parsed.source, container, existing)
  }
  return addField(parsed.source, container, fieldName, hasSubfields)
}

function findFieldInSelections(selections: SelectionNode[], fieldName: string): FieldSelectionNode | undefined {
  return selections.find((selection): selection is FieldSelectionNode => selection.kind === 'field' && selection.name === fieldName)
}

/**
 * Garante que cada segmento de `path` já esteja selecionado, adicionando
 * (como `{}`) os que faltarem — do início ao fim do caminho. Permite marcar
 * um campo aninhado direto pela árvore de exploração sem que o usuário
 * precise selecionar cada ancestral manualmente primeiro.
 *
 * Todo segmento de `path` é, por construção, um campo com subcampos (é
 * assim que a UI chega a ele), então sempre é adicionado com chaves `{}`.
 */
export function ensureFieldPath(parsed: ParsedQuery, path: string[]): ParsedQuery {
  let current = parsed
  for (let index = 0; index < path.length; index++) {
    const segment = path[index]
    if (current.source.trim().length === 0) {
      current = parseQuery(toggleField(current, [], segment, true))!
      continue
    }
    const container = resolveContainer(current, path.slice(0, index))
    if (!container) return current
    if (!findFieldInSelections(container.selections, segment)) {
      current = parseQuery(addField(current.source, container, segment, true))!
    }
  }
  return current
}

export interface ArgPair {
  name: string
  value: string
}

function findTopLevelColon(segment: string): number {
  let depth = 0
  let inString = false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ':' && depth === 0) return i
  }
  return -1
}

/** Interpreta o texto bruto de argumentos (ex.: `(a: 1, b: "x")`) em pares nome/valor, sem validar os valores. */
export function parseArgPairs(argsText: string): ArgPair[] {
  if (argsText.length < 2) return []
  const content = argsText.slice(1, -1)
  const pairs: ArgPair[] = []
  let depth = 0
  let inString = false
  let segmentStart = 0

  const pushSegment = (end: number) => {
    const segment = content.slice(segmentStart, end)
    const colonIndex = findTopLevelColon(segment)
    if (colonIndex === -1) return
    const name = segment.slice(0, colonIndex).trim()
    const value = segment.slice(colonIndex + 1).trim()
    if (name.length > 0 && value.length > 0) pairs.push({ name, value })
  }

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      pushSegment(i)
      segmentStart = i + 1
    }
  }
  pushSegment(content.length)
  return pairs
}

/** Valor bruto (com aspas/colchetes, se houver) do argumento `argName` de `fieldName` em `path`, ou `undefined`. */
export function getArgValue(parsed: ParsedQuery, path: string[], fieldName: string, argName: string): string | undefined {
  const container = resolveContainer(parsed, path)
  if (!container) return undefined
  const field = findFieldInSelections(container.selections, fieldName)
  if (!field) return undefined
  return parseArgPairs(field.args).find((pair) => pair.name === argName)?.value
}

function spliceFieldArgs(source: string, field: FieldSelectionNode, argName: string, literal: string | null): string {
  const pairs = parseArgPairs(field.args).filter((pair) => pair.name !== argName)
  if (literal !== null) pairs.push({ name: argName, value: literal })

  if (pairs.length === 0) {
    if (!field.argsRange) return source
    return spliceSource(source, field.argsRange.start, field.argsRange.end, '')
  }

  const text = `(${pairs.map((pair) => `${pair.name}: ${pair.value}`).join(', ')})`
  if (field.argsRange) {
    return spliceSource(source, field.argsRange.start, field.argsRange.end, text)
  }
  const insertAt = field.start + field.name.length
  return spliceSource(source, insertAt, insertAt, text)
}

/**
 * Define (ou remove, se `literal` for `null`) um argumento de `fieldName` em
 * `path`. Garante o caminho e o próprio campo antes de editar — permite
 * digitar direto num argumento de um campo ainda não selecionado, cascateando
 * a seleção dos ancestrais e do campo, igual a `toggleField`/`ensureFieldPath`
 * fariam separadamente. Remover o argumento de um campo que nem está
 * selecionado é um no-op (nada a remover).
 */
export function setFieldArgument(
  parsed: ParsedQuery,
  path: string[],
  fieldName: string,
  hasSubfields: boolean,
  argName: string,
  literal: string | null,
): string {
  if (literal === null) {
    const container = resolveContainer(parsed, path)
    const field = container && findFieldInSelections(container.selections, fieldName)
    if (!field) return parsed.source
    return spliceFieldArgs(parsed.source, field, argName, null)
  }

  const ensured = ensureFieldPath(parsed, path)
  const container = resolveContainer(ensured, path)
  if (!container) return ensured.source

  let field = findFieldInSelections(container.selections, fieldName)
  let source = ensured.source
  if (!field) {
    // Query totalmente vazia (só chega aqui com `path` vazio — do contrário
    // `ensureFieldPath` já teria montado `{}` ao redor dos ancestrais):
    // precisa do bootstrap de `toggleField`, não só inserir entre chaves
    // que ainda não existem no texto.
    source = source.trim().length === 0 ? toggleField(ensured, path, fieldName, hasSubfields) : addField(source, container, fieldName, hasSubfields)
    const reparsed = parseQuery(source)!
    field = findFieldInSelections(resolveContainer(reparsed, path)!.selections, fieldName)!
  }
  return spliceFieldArgs(source, field, argName, literal)
}
