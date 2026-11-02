import { indexJsonValues } from './json-value-index'
import type { JsonPathSegment } from './json-value-index'

/** Mesmo limite do backend (`MAX_MONITOR_CANDIDATES`): acima disso a avaliação é cortada e o usuário avisado. */
export const MAX_MONITOR_CANDIDATES = 10_000

/** Valor primitivo (ou array vazio) do documento que pode interessar a algum monitor, com a faixa que ocupa no texto. */
export interface MonitorCandidate {
  from: number
  to: number
  path: JsonPathSegment[]
  /** Literal JSON como aparece no texto (`"Ana"`, `12.5`, `null`, `[]`). */
  literal: string
}

export interface MonitorCandidates {
  candidates: MonitorCandidate[]
  truncated: boolean
}

/** Última chave de um campo configurado (`itens[].nome` → `nome`), no mesmo formato que o backend casa. */
export function lastFieldKey(field: string): string {
  const segments = field.split('.')
  return segments[segments.length - 1].trim().replace(/\[\]$/, '').trim()
}

/** Última chave do caminho de um valor; os índices depois dela são de itens do array guardado nela. */
function lastPathKey(path: readonly JsonPathSegment[]): string | undefined {
  for (let index = path.length - 1; index >= 0; index--) {
    const segment = path[index]
    if (typeof segment === 'string') return segment
  }
  return undefined
}

/**
 * Pré-filtro barato antes do IPC: só os valores cuja última chave é usada
 * por algum campo monitorado — o próprio valor da chave ou itens do array
 * guardado nela, incluindo arrays vazios. O casamento completo (sufixo do
 * caminho) e as regras ficam no backend. Documento que não é JSON válido
 * não tem candidatos.
 */
export function monitorCandidates(text: string, lastKeys: readonly string[]): MonitorCandidates {
  const keys = new Set(lastKeys)
  if (keys.size === 0) return { candidates: [], truncated: false }
  const candidates: MonitorCandidate[] = []
  let truncated = false
  for (const value of indexJsonValues(text, { emptyArrays: true })) {
    const last = lastPathKey(value.path)
    if (last === undefined || !keys.has(last)) continue
    if (candidates.length === MAX_MONITOR_CANDIDATES) {
      truncated = true
      break
    }
    candidates.push({ from: value.from, to: value.to, path: value.path, literal: text.slice(value.from, value.to) })
  }
  return { candidates, truncated }
}
