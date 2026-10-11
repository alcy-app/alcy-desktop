/**
 * Resolução de `{{variável}}` e de `/:parametro`, com as mesmas regras do
 * backend (`crates/alcy-app/src/resolve_variables.rs` e
 * `resolve_request_variables.rs`).
 */

import type { Variable } from './types'

export interface Resolution {
  text: string
  /** Nomes referenciados sem valor. */
  missing: string[]
}

/**
 * Troca cada `{{nome}}` pelo valor. `{{` sem `}}` fica literal; um nome sem
 * valor fica como está e entra em `missing`.
 */
export function resolveTemplate(template: string, variables: ReadonlyMap<string, string>): Resolution {
  let text = ''
  const missing: string[] = []
  let rest = template
  for (;;) {
    const start = rest.indexOf('{{')
    if (start < 0) break
    const end = rest.indexOf('}}', start + 2)
    if (end < 0) break
    text += rest.slice(0, start)
    const name = rest.slice(start + 2, end).trim()
    const value = variables.get(name)
    if (value === undefined) {
      missing.push(name)
      text += rest.slice(start, end + 2)
    } else {
      text += value
    }
    rest = rest.slice(end + 2)
  }
  return { text: text + rest, missing }
}

/** Variáveis vigentes: ambiente, depois cada pasta (a mais próxima vence). */
export function mergeVariables(environment: Variable[], scopes: Variable[][]): Map<string, string> {
  const merged = new Map<string, string>()
  for (const variable of environment) merged.set(variable.name, variable.value)
  for (const scope of scopes) for (const variable of scope) merged.set(variable.name, variable.value)
  return merged
}

const isRouteNameChar = (char: string) => /[A-Za-z0-9_-]/.test(char)

/** Substitui `/:nome` só no caminho (antes de `?`/`#`). */
export function applyRouteParameters(url: string, parameters: Variable[]): string {
  const cut = url.search(/[?#]/)
  const pathEnd = cut < 0 ? url.length : cut
  const path = url.slice(0, pathEnd)
  let output = ''
  let cursor = 0
  let index = 0
  while (index + 2 < path.length) {
    if (path[index] === '/' && path[index + 1] === ':') {
      let end = index + 2
      while (end < path.length && isRouteNameChar(path[end])) end++
      if (end > index + 2) {
        const name = path.slice(index + 2, end)
        const parameter = parameters.find((candidate) => candidate.name === name)
        if (parameter) {
          output += path.slice(cursor, index + 1) + parameter.value
          cursor = end
          index = end
          continue
        }
      }
    }
    index++
  }
  return output + path.slice(cursor) + url.slice(pathEnd)
}
