/** Edição em massa de linhas chave-valor: cada linha do texto é `nome:valor`;
 * o prefixo `//` marca a linha como desativada (quando suportado). */

export interface BulkRow {
  name: string
  value: string
  enabled: boolean
}

interface ParseOptions {
  /** Interpreta o prefixo `//` como linha desativada. Padrão: `true`. */
  allowDisabled?: boolean
}

export function serializeBulk(rows: Array<{ name: string; value: string; enabled?: boolean }>): string {
  return rows.map((row) => `${row.enabled === false ? '// ' : ''}${row.name}:${row.value}`).join('\n')
}

export function parseBulk(text: string, { allowDisabled = true }: ParseOptions = {}): BulkRow[] {
  const rows: BulkRow[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    let enabled = true
    if (allowDisabled && line.startsWith('//')) {
      enabled = false
      line = line.slice(2).trim()
    }
    if (line === '') continue
    const separator = line.indexOf(':')
    const name = (separator === -1 ? line : line.slice(0, separator)).trim()
    const value = separator === -1 ? '' : line.slice(separator + 1).trim()
    if (name === '' && value === '') continue
    rows.push({ name, value, enabled })
  }
  return rows
}

/** Para cada linha lida, devolve a linha existente correspondente (ou `undefined`):
 * primeiro por nome igual, depois pela mesma posição — assim ids e estados extras
 * (ex.: `sensitive`) sobrevivem enquanto o usuário digita no texto. */
export function matchExistingRows<T extends { name: string }>(existing: T[], parsed: Array<{ name: string }>): Array<T | undefined> {
  const used = new Set<number>()
  const matches: Array<T | undefined> = parsed.map((row) => {
    const index = existing.findIndex((candidate, i) => !used.has(i) && candidate.name === row.name)
    if (index === -1) return undefined
    used.add(index)
    return existing[index]
  })
  return matches.map((match, position) => {
    if (match !== undefined) return match
    if (position < existing.length && !used.has(position)) {
      used.add(position)
      return existing[position]
    }
    return undefined
  })
}
