export const SECRET_MASK = '••••'
const SECRET_NAME = /authorization|token|secret|api[-_]?key|cookie|password|session/i
const SECRET_PROPERTY = /^(token|password|clientSecret)$/i
const VARIABLE_REFERENCE = /^\s*\{\{[^{}]+\}\}\s*$/
const TRUNCATED = '[agent:truncated]'
/**
 * Secrets are also searched inside other text (a token in a URL, an error);
 * shorter ones would match everywhere: a password `a` masked every `a` of every
 * id and name, and no tool call could name an item. Their own fields stay masked.
 */
const MIN_EMBEDDED_SECRET_LENGTH = 6
/** Identifiers the app generates are never secret, and the model needs them intact. */
const ID_KEY = /^(id|.*Id|.*Ids)$/

export function record(value: unknown, label = 'input'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

export function string(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string' || !(input[key] as string).trim()) throw new Error(`${key} must be a nonempty string.`)
  return input[key] as string
}

export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${label} must be a list of strings.`)
  return value as string[]
}

/** Collect only credential fields already held by the UI, never keyring or filesystem values. */
export function resourceSecrets(value: unknown): string[] {
  const secrets = new Set<string>()
  const walk = (item: unknown) => {
    if (Array.isArray(item)) { item.forEach(walk); return }
    if (!item || typeof item !== 'object') return
    const object = item as Record<string, unknown>
    const sensitive = object.sensitive === true || object.type === 'customHeader' || (typeof object.name === 'string' && SECRET_NAME.test(object.name))
    for (const [key, child] of Object.entries(object)) {
      if (typeof child === 'string' && (SECRET_PROPERTY.test(key) || (key === 'value' && sensitive))) {
        if (child && child !== SECRET_MASK && !VARIABLE_REFERENCE.test(child)) secrets.add(child)
      } else if (key === 'config' && typeof child === 'string') {
        try { walk(JSON.parse(child)) } catch { /* Invalid load JSON remains a draft. */ }
      } else walk(child)
    }
  }
  walk(value)
  return [...secrets].sort((a, b) => b.length - a.length)
}

/** Secret fields are redacted at every nesting level, including inline requests and mocks. */
export function redactResource(value: unknown, secrets: readonly string[] = []): unknown {
  const mask = (text: string) => text === '' || VARIABLE_REFERENCE.test(text) ? text : SECRET_MASK
  const embedded = secrets.filter((secret) => secret.length >= MIN_EMBEDDED_SECRET_LENGTH && !VARIABLE_REFERENCE.test(secret))
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let text = item
      for (const secret of embedded) text = text.split(secret).join(SECRET_MASK)
      return text
    }
    if (Array.isArray(item)) return item.map(walk)
    if (!item || typeof item !== 'object') return item
    const object = item as Record<string, unknown>
    const sensitiveValue = object.sensitive === true || object.type === 'customHeader' || (typeof object.name === 'string' && SECRET_NAME.test(object.name))
    return Object.fromEntries(Object.entries(object).map(([key, child]) => {
      if (key === 'config' && typeof child === 'string') {
        try { return [key, JSON.stringify(walk(JSON.parse(child)))] } catch { /* Preserve invalid draft text. */ }
      }
      if (typeof child === 'string' && (SECRET_PROPERTY.test(key) || (key === 'value' && sensitiveValue))) return [key, mask(child)]
      if (ID_KEY.test(key) && (typeof child === 'string' || (Array.isArray(child) && child.every((entry) => typeof entry === 'string')))) return [key, child]
      return [key, walk(child)]
    }))
  }
  return walk(value)
}

/** Omitted properties keep their values. Arrays match identities before restoring masked fields. */
export function mergeResource(previous: unknown, patch: unknown): unknown {
  if (typeof patch === 'string' && patch.includes(TRUNCATED)) throw new Error('Truncated content cannot be written back. Change only the fields you need.')
  if (patch === SECRET_MASK) {
    if (previous === undefined) throw new Error('A secret mask is not a value. Use a {{variable}} reference.')
    return previous
  }
  if (typeof patch === 'string' && patch.includes(SECRET_MASK)) throw new Error('A masked string cannot be written back. Change individual fields or use a {{variable}} reference.')
  if (Array.isArray(patch)) {
    const old = Array.isArray(previous) ? previous : []
    return patch.map((entry) => {
      const identity = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
      const key = identity?.id !== undefined ? 'id' : identity?.name !== undefined ? 'name' : null
      const match = key ? old.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>)[key] === identity?.[key]) : undefined
      return mergeResource(match, entry)
    })
  }
  if (patch && typeof patch === 'object') {
    const candidate = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, unknown> : {}
    const nextObject = patch as Record<string, unknown>
    const old = (nextObject.type !== undefined && candidate.type !== nextObject.type) || (nextObject.kind !== undefined && candidate.kind !== nextObject.kind) ? {} : candidate
    return { ...old, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Invalid property name.')
      if (['filePath', 'files', 'importPaths'].includes(key) && JSON.stringify(old[key]) !== JSON.stringify(value)) throw new Error('Select local files in the editor first; only existing file references can be reused.')
      if (key === 'config' && typeof old[key] === 'string' && typeof value === 'string' && value.includes(SECRET_MASK)) {
        try { return [key, JSON.stringify(mergeResource(JSON.parse(old[key]), JSON.parse(value)))] } catch { throw new Error('Cannot restore secrets in this load configuration.') }
      }
      return [key, mergeResource(old[key], value)]
    })) }
  }
  return patch
}

export function page<T>(items: readonly T[], input: Record<string, unknown>) {
  const integer = (key: string, fallback: number, max: number) => {
    const value = input[key] ?? fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max || (key === 'limit' && value === 0)) throw new Error(`Invalid ${key}.`)
    return value
  }
  const offset = integer('offset', 0, Number.MAX_SAFE_INTEGER)
  const limit = integer('limit', 20, 50)
  const entries = items.slice(offset, offset + limit)
  return { items: entries, total: items.length, offset, nextOffset: offset + entries.length < items.length ? offset + entries.length : null }
}

/** Keep valid JSON below the native transcript limit, even for one very large node. */
export function boundedResource(value: unknown): string {
  let remaining = 24_000
  const bytes = (item: unknown) => new TextEncoder().encode(JSON.stringify(item)).length
  const walk = (item: unknown, depth: number): unknown => {
    if (remaining <= 0 || depth > 24) return TRUNCATED
    if (typeof item === 'string') {
      let text = item.slice(0, Math.min(4000, Math.max(0, remaining - 100)))
      while (bytes(text) > remaining - 100 && text.length > 0) text = text.slice(0, Math.floor(text.length / 2))
      const result = text.length < item.length ? text + TRUNCATED : text
      remaining -= bytes(result) + 2
      return result
    }
    if (Array.isArray(item)) {
      remaining -= 2
      const result: unknown[] = []
      for (const child of item) {
        if (remaining <= 0) { result.push(TRUNCATED); break }
        result.push(walk(child, depth + 1))
      }
      return result
    }
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(item)) {
        remaining -= bytes(key) + 2
        if (remaining <= 0) { result.truncated = true; break }
        result[key] = walk(child, depth + 1)
      }
      return result
    }
    remaining -= 20
    return item
  }
  return JSON.stringify(walk(value, 0))
}
