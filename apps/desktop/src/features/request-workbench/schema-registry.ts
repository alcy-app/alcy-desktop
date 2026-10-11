import type { LoadSchemaOutput } from '../../bindings/load-schema'

/**
 * Schemas já carregados nesta sessão, por referência fraca. Cada aba GraphQL
 * carrega o próprio schema, e várias abas no mesmo endpoint recebiam cópias
 * idênticas (um schema grande são dezenas de MB de objetos). `internSchema`
 * troca a cópia recém-chegada pela instância equivalente que já está em uso,
 * e a cópia nova vira lixo logo. O `WeakRef` deixa o schema ser liberado
 * quando nenhuma aba o usa mais, sem contagem manual de referências.
 */
const loaded = new Set<WeakRef<LoadSchemaOutput>>()

/** Devolve a instância já carregada estruturalmente igual a `schema`, ou registra `schema` e o devolve. */
export function internSchema(schema: LoadSchemaOutput): LoadSchemaOutput {
  for (const reference of loaded) {
    const existing = reference.deref()
    if (existing === undefined) {
      loaded.delete(reference)
      continue
    }
    if (existing === schema) return existing
    if (sameShape(existing, schema) && deepEqual(existing, schema)) return existing
  }
  loaded.add(new WeakRef(schema))
  return schema
}

/** Filtro barato antes da comparação completa. */
function sameShape(a: LoadSchemaOutput, b: LoadSchemaOutput): boolean {
  return (
    a.queryType === b.queryType &&
    a.mutationType === b.mutationType &&
    a.subscriptionType === b.subscriptionType &&
    a.types.length === b.types.length &&
    a.directives.length === b.directives.length
  )
}

/** Igualdade estrutural de dados JSON (objetos simples, arrays e primitivos). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const keys = Object.keys(aRecord)
  if (keys.length !== Object.keys(bRecord).length) return false
  for (const key of keys) {
    if (!(key in bRecord) || !deepEqual(aRecord[key], bRecord[key])) return false
  }
  return true
}
