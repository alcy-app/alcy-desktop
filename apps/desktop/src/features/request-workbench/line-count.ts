/** Conta as linhas de `text` sem alocar: `split('\n')` criaria uma string por
 * linha (um milhão de substrings num corpo de resposta grande) só para medir
 * o tamanho do array, e isso rodava a cada renderização do painel. */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  let index = text.indexOf('\n')
  while (index !== -1) {
    lines += 1
    index = text.indexOf('\n', index + 1)
  }
  return lines
}
