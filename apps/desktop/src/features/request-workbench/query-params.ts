export interface ParsedParam {
  name: string
  value: string
}

export interface ParsedRouteParam {
  name: string
}

export interface RouteParamRange extends ParsedRouteParam {
  /** Intervalo do token ":nome" na string original; end é exclusivo. */
  start: number
  end: number
}

/** Mantém o mesmo alfabeto aceito pelo parser de tokens de rota. */
export function normalizeRouteParamName(name: string): string {
  return name.replace(/^:+/, '').replace(/[^A-Za-z0-9_-]/g, '')
}

/** Localiza todas as ocorrências de "/:nome" no caminho, sem confundir os
 * dois-pontos do esquema, porta, query string ou fragmento. */
export function findRouteParamRanges(url: string): RouteParamRange[] {
  const pathEnd = [url.indexOf('?'), url.indexOf('#')]
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), url.length)
  const withoutSuffix = url.slice(0, pathEnd)
  const schemeIndex = withoutSuffix.indexOf('://')
  const pathStart =
    schemeIndex === -1
      ? 0
      : (() => {
          const index = withoutSuffix.indexOf('/', schemeIndex + 3)
          return index === -1 ? pathEnd : index
        })()
  const path = url.slice(pathStart, pathEnd)

  return [...path.matchAll(/\/:([A-Za-z0-9_-]+)/g)].map((match) => {
    const start = pathStart + (match.index ?? 0) + 1
    return { name: match[1], start, end: start + match[0].length - 1 }
  })
}

/** Aplica os valores conhecidos aos tokens de rota, preservando tokens sem
 * correspondência e qualquer conteúdo fora do caminho. */
export function applyRouteParamValues(
  url: string,
  parameters: ReadonlyArray<{ name: string; value: string }>,
): string {
  const ranges = findRouteParamRanges(url)
  let result = ''
  let cursor = 0

  for (const range of ranges) {
    result += url.slice(cursor, range.start)
    const parameter = parameters.find((candidate) => candidate.name === range.name)
    result += parameter?.value ?? url.slice(range.start, range.end)
    cursor = range.end
  }

  return result + url.slice(cursor)
}

/** Renomeia todas as ocorrências de um parâmetro de rota no caminho. */
export function renameRouteParamInUrl(url: string, oldName: string, newName: string): string {
  const normalized = normalizeRouteParamName(newName)
  return findRouteParamRanges(url)
    .filter((range) => range.name === oldName)
    .reverse()
    .reduce((current, range) => current.slice(0, range.start) + `:${normalized}` + current.slice(range.end), url)
}

/** Remove do caminho todos os segmentos associados ao nome informado. */
export function removeRouteParamFromUrl(url: string, name: string): string {
  return findRouteParamRanges(url)
    .filter((range) => range.name === name)
    .reverse()
    .reduce((current, range) => current.slice(0, range.start - 1) + current.slice(range.end), url)
}

/** Extrai os nomes únicos que alimentam a grid de parâmetros de rota. */
export function parseRouteParams(url: string): ParsedRouteParam[] {
  const names = new Set<string>()
  const params: ParsedRouteParam[] = []
  for (const { name } of findRouteParamRanges(url)) {
    if (!names.has(name)) {
      names.add(name)
      params.push({ name })
    }
  }
  return params
}

/** Extrai os pares nome/valor da query string de `url` (tudo após o primeiro
 * `?`). Não decodifica/codifica percent-encoding nem interpola `{{var}}` —
 * mesmo tratamento que `Endpoint` já dá à URL inteira (texto cru). */
export function parseQueryParams(url: string): ParsedParam[] {
  const queryIndex = url.indexOf('?')
  if (queryIndex === -1) return []

  const queryString = url.slice(queryIndex + 1)
  if (queryString === '') return []

  return queryString.split('&').map((pair) => {
    const eqIndex = pair.indexOf('=')
    return eqIndex === -1 ? { name: pair, value: '' } : { name: pair.slice(0, eqIndex), value: pair.slice(eqIndex + 1) }
  })
}

/** Reconstrói `url` trocando sua query string pelos parâmetros habilitados e
 * com nome não vazio, na ordem em que aparecem em `params`. Preserva tudo
 * antes do primeiro `?` de `url` inalterado. Sem parâmetros habilitados,
 * remove o `?` por completo. */
export function buildUrlWithParams(url: string, params: { name: string; value: string; enabled: boolean }[]): string {
  const queryIndex = url.indexOf('?')
  const base = queryIndex === -1 ? url : url.slice(0, queryIndex)

  const queryString = params
    .filter((param) => param.enabled && param.name !== '')
    .map((param) => (param.value === '' ? param.name : `${param.name}=${param.value}`))
    .join('&')

  return queryString === '' ? base : `${base}?${queryString}`
}
