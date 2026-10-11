/**
 * Reformata o corpo de uma resposta com indentação de 2 espaços. Devolve o
 * texto original sem alterações quando não é JSON válido (ex.: resposta de
 * erro em texto puro ou HTML) — nunca esconde o corpo real por causa de um
 * formato inesperado.
 */
export function formatJsonBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

const INDENT_UNIT = '  '

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

/**
 * Índice logo após o fechamento da string iniciada em `start` (a aspa de
 * abertura), respeitando escapes; `text.length` quando a string ainda não
 * terminou — o caso normal de um documento parcial.
 */
function stringEnd(text: string, start: number): number {
  let i = start + 1
  for (;;) {
    const quote = text.indexOf('"', i)
    if (quote === -1) return text.length
    let backslashes = 0
    for (let j = quote - 1; j > start && text[j] === '\\'; j--) backslashes++
    if (backslashes % 2 === 0) return quote + 1
    i = quote + 1
  }
}

/**
 * Indenta com 2 espaços um JSON possivelmente incompleto — o acumulado até
 * agora de um corpo `windowed` ainda carregando, que `formatJsonBody` não
 * consegue formatar (`JSON.parse` falha em documento truncado). Não valida
 * nada: só reposiciona quebras de linha e indentação fora de strings, então
 * roda em uma passada e nunca lança. Para JSON válido e compacto, a saída é
 * a mesma de `formatJsonBody`, exceto pela normalização de números e escapes
 * que `JSON.stringify` faz — a troca pelo formatado final não desloca linhas.
 * Texto que não começa com `{`/`[` volta intacto.
 */
export function formatPartialJsonBody(body: string): string {
  const first = body.trimStart()[0]
  if (first !== '{' && first !== '[') return body

  const out: string[] = []
  let depth = 0
  const newline = () => '\n' + INDENT_UNIT.repeat(depth)

  let i = 0
  while (i < body.length) {
    const char = body[i]
    if (isJsonWhitespace(char)) {
      i++
      continue
    }
    if (char === '"') {
      const end = stringEnd(body, i)
      out.push(body.slice(i, end))
      i = end
      continue
    }
    if (char === '{' || char === '[') {
      let next = i + 1
      while (next < body.length && isJsonWhitespace(body[next])) next++
      const closer = char === '{' ? '}' : ']'
      if (body[next] === closer) {
        out.push(char + closer)
        i = next + 1
        continue
      }
      depth++
      out.push(char)
      if (next < body.length) out.push(newline())
      i = next
      continue
    }
    if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1)
      out.push(newline(), char)
      i++
      continue
    }
    if (char === ',') {
      out.push(',', newline())
      i++
      continue
    }
    if (char === ':') {
      out.push(': ')
      i++
      continue
    }
    // Literal (número, true/false/null ou lixo): copia até o próximo delimitador.
    let end = i + 1
    while (end < body.length && !isJsonWhitespace(body[end]) && !'{}[],:"'.includes(body[end])) end++
    out.push(body.slice(i, end))
    i = end
  }

  return out.join('')
}
