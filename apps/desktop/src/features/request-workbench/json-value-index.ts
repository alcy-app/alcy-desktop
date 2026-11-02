/** Segmento de um caminho dentro de um documento JSON: chave de objeto ou índice de array. */
export type JsonPathSegment = string | number

/** Um valor primitivo (string, número, booleano ou null) do documento, com a
 * faixa de caracteres que ele ocupa e o caminho até ele. */
export interface JsonValueRange {
  from: number
  to: number
  path: JsonPathSegment[]
}

const LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y

export interface IndexJsonOptions {
  /** Inclui também os arrays vazios (`[]`), com a faixa do colchete de abertura ao de fechamento. */
  emptyArrays?: boolean
}

/**
 * Indexa, em ordem de documento, todos os valores primitivos de um JSON
 * (aproximadamente linear no tamanho do texto). Devolve `[]` quando o texto
 * não é JSON válido — o chamador simplesmente não oferece captura.
 */
export function indexJsonValues(text: string, options: IndexJsonOptions = {}): JsonValueRange[] {
  const values: JsonValueRange[] = []
  let i = 0

  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }

  const readString = (): string => {
    const start = i
    i++ // aspas de abertura
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) throw new SyntaxError('string não terminada')
    i++ // aspas de fechamento
    return JSON.parse(text.slice(start, i)) as string
  }

  const readValue = (path: JsonPathSegment[]) => {
    skipSpace()
    const char = text[i]
    if (char === '{') {
      i++
      skipSpace()
      if (text[i] === '}') return void i++
      for (;;) {
        skipSpace()
        if (text[i] !== '"') throw new SyntaxError('chave esperada')
        const key = readString()
        skipSpace()
        if (text[i++] !== ':') throw new SyntaxError('":" esperado')
        readValue([...path, key])
        skipSpace()
        const next = text[i++]
        if (next === '}') return
        if (next !== ',') throw new SyntaxError('"," esperada')
      }
    }
    if (char === '[') {
      const from = i
      i++
      skipSpace()
      if (text[i] === ']') {
        i++
        if (options.emptyArrays) values.push({ from, to: i, path })
        return
      }
      for (let index = 0; ; index++) {
        readValue([...path, index])
        skipSpace()
        const next = text[i++]
        if (next === ']') return
        if (next !== ',') throw new SyntaxError('"," esperada')
      }
    }
    const from = i
    if (char === '"') {
      readString()
    } else {
      LITERAL.lastIndex = i
      const match = LITERAL.exec(text)
      if (!match) throw new SyntaxError('valor esperado')
      i += match[0].length
    }
    values.push({ from, to: i, path })
  }

  try {
    readValue([])
    skipSpace()
    if (i !== text.length) return []
  } catch {
    return []
  }
  return values
}

/** Valor cuja faixa contém `pos` (extremos incluídos), por busca binária no índice. */
export function findValueAt(values: JsonValueRange[], pos: number): JsonValueRange | null {
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = values[mid]
    if (pos < value.from) high = mid - 1
    else if (pos > value.to) low = mid + 1
    else return value
  }
  return null
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Expressão JavaScript que acessa o caminho a partir do JSON da resposta (`al.response.json()`). */
export function accessorFor(path: JsonPathSegment[]): string {
  return path
    .map((segment) =>
      typeof segment === 'number' ? `[${segment}]` : IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
    )
    .join('')
}

/** Nome sugerido para a variável de ambiente: a última chave do caminho, só com letras, dígitos e `_`. */
export function captureVariableName(path: JsonPathSegment[]): string {
  const lastKey = [...path].reverse().find((segment): segment is string => typeof segment === 'string')
  const name = (lastKey ?? 'value').replace(/[^\w]/g, '_')
  return name === '' ? 'value' : name
}

/** Linha de script que grava o valor do caminho numa variável de ambiente. */
export function captureStatement(path: JsonPathSegment[]): string {
  return `al.environment.set('${captureVariableName(path)}', al.response.json()${accessorFor(path)});`
}
