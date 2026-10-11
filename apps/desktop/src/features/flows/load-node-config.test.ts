import { describe, expect, it } from 'vitest'
import { EXECUTABLE_LOAD_NODE_KINDS, LOAD_NODE_DEFINITIONS, defaultLoadNodeConfig } from './load-node-config'

describe('load node defaults', () => {
  it('oferece somente blocos que o runtime executa neste checkpoint', () => {
    expect(EXECUTABLE_LOAD_NODE_KINDS).toContain('script')
    expect(EXECUTABLE_LOAD_NODE_KINDS).toContain('extract')
  })

  it('gera JSON válido e uma saída compatível para cada bloco executável', () => {
    for (const kind of EXECUTABLE_LOAD_NODE_KINDS) {
      expect(() => JSON.parse(defaultLoadNodeConfig(kind))).not.toThrow()
      expect(LOAD_NODE_DEFINITIONS[kind].outputs).toBeDefined()
    }
  })
})
