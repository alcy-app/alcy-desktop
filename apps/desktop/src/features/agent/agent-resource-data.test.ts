import { describe, expect, it } from 'vitest'
import { boundedResource, mergeResource, page, redactResource, resourceSecrets, SECRET_MASK } from './agent-resource-data'
import { patchFlow, patchMonitor } from './agent-resource-tools'
import { createFlow, dtoFromFlow } from '../flows/use-flows-state'

describe('agent resource data boundaries', () => {
  it('masks nested credentials, serialized load headers and known secrets in URLs and errors', () => {
    const input = {
      authentication: { type: 'bearer', token: 'credential' },
      config: JSON.stringify({ headers: [{ name: 'Authorization', value: 'Bearer credential' }], variables: { host: '{{base}}' } }),
      variables: [{ name: 'key', value: 'sensitive-value', sensitive: true }],
      endpoint: 'https://example.test/?key=sensitive-value',
    }
    const secrets = resourceSecrets(input)
    expect(secrets).toContain('credential')
    const text = JSON.stringify(redactResource(input, secrets))
    expect(text).not.toContain('credential')
    expect(text).not.toContain('sensitive-value')
    expect(text).toContain('{{base}}')
  })

  it('keeps ids and other text intact when a secret is too short to search for', () => {
    const input = {
      variables: [{ name: 'password', value: 'a', sensitive: true }],
      requests: [{ id: 'cf3a9e10-2451d', name: 'Get Users', url: 'https://api.test/users?pass=a', requestIds: ['ab1', 'cd2'] }],
      changes: ['addFields'],
    }
    const redacted = redactResource(input, resourceSecrets(input)) as typeof input
    expect(redacted.variables[0].value).toBe(SECRET_MASK)
    expect(redacted.requests[0]).toEqual(input.requests[0])
    expect(redacted.changes).toEqual(['addFields'])
  })

  it('never masks identifiers, even when a secret appears inside them', () => {
    const input = { flowId: 'flow-sensitive-value', nodeIds: ['n-sensitive-value'], note: 'uses sensitive-value', variables: [{ name: 'k', value: 'sensitive-value', sensitive: true }] }
    const redacted = redactResource(input, resourceSecrets(input)) as typeof input
    expect(redacted.flowId).toBe('flow-sensitive-value')
    expect(redacted.nodeIds).toEqual(['n-sensitive-value'])
    expect(redacted.note).toBe(`uses ${SECRET_MASK}`)
  })

  it('restores masked fields by stable identity and preserves omitted properties', () => {
    const previous = { name: 'Mock', port: 3001, routes: [{ id: 'route', headers: [{ name: 'Authorization', value: 'saved-secret' }], enabled: true }] }
    const next = mergeResource(previous, { routes: [{ id: 'route', headers: [{ name: 'Authorization', value: SECRET_MASK }], enabled: false }] })
    expect(next).toEqual({ ...previous, routes: [{ ...previous.routes[0], enabled: false }] })
    expect(previous.routes[0].enabled).toBe(true)
  })

  it('does not retain fields from a different discriminated variant', () => {
    expect(mergeResource({ type: 'bearer', token: 'old' }, { type: 'none' })).toEqual({ type: 'none' })
  })

  it('restores masks inside serialized load configuration without storing a mask', () => {
    const old = { config: JSON.stringify({ headers: [{ name: 'Authorization', value: 'saved' }], vus: 1 }) }
    const next = mergeResource(old, { config: JSON.stringify({ headers: [{ name: 'Authorization', value: SECRET_MASK }], vus: 2 }) }) as typeof old
    expect(JSON.parse(next.config)).toEqual({ headers: [{ name: 'Authorization', value: 'saved' }], vus: 2 })
  })

  it('rejects masks with no original, truncated text and prototype keys', () => {
    expect(() => mergeResource({}, { token: SECRET_MASK })).toThrow('secret mask')
    expect(() => mergeResource({}, { body: 'partial[agent:truncated]' })).toThrow('Truncated')
    expect(() => mergeResource({}, { body: 'Bearer ••••' })).toThrow('masked string')
    expect(() => mergeResource({}, JSON.parse('{"__proto__":{"admin":true}}'))).toThrow('Invalid property')
    expect(() => mergeResource({}, { restBody: { type: 'binary', filePath: '/private/data' } })).toThrow('Select local files')
  })

  it('paginates with recoverable offsets and rejects invalid limits', () => {
    const values = Array.from({ length: 55 }, (_, index) => index)
    expect(page(values, { offset: 50, limit: 5 })).toEqual({ items: [50, 51, 52, 53, 54], total: 55, offset: 50, nextOffset: null })
    expect(page(values, {}).nextOffset).toBe(20)
    expect(() => page(values, { limit: 51 })).toThrow('limit')
    expect(() => page(values, { offset: -1 })).toThrow('offset')
  })

  it('keeps valid JSON below the transcript limit even with escaped Unicode strings', () => {
    const output = boundedResource({ items: Array.from({ length: 100 }, () => ({ body: '\u0000😀"\\'.repeat(20_000) })) })
    expect(new TextEncoder().encode(output).length).toBeLessThan(32 * 1024)
    expect(() => JSON.parse(output)).not.toThrow()
    expect(output).toContain('[agent:truncated]')
  })
})

describe('partial flow and monitor edits', () => {
  it('updates one node without dropping existing positions or disconnected nodes', () => {
    const original = dtoFromFlow(createFlow('Example'))
    const added = patchFlow(original, { upsertNodes: [{ id: 'log', kind: 'log', message: 'First', x: 500, y: 100 }, { id: 'display', kind: 'display', template: '{{nodes.log.message}}' }], upsertEdges: [{ id: 'edge', sourceNodeId: 'start', targetNodeId: 'log' }] })
    const edited = patchFlow(added, { upsertNodes: [{ id: 'log', message: 'Second' }] })
    expect(edited.nodes).toHaveLength(3)
    expect(edited.nodes[1]).toMatchObject({ message: 'Second', x: 500, y: 100 })
    expect(edited.edges).toEqual(added.edges)
    expect(added.nodes[1]).toMatchObject({ message: 'First' })
  })

  it('removes incident edges and panels and prevents removal of Start', () => {
    const original = patchFlow(dtoFromFlow(createFlow('Example')), { upsertNodes: [{ id: 'display', kind: 'display' }], upsertEdges: [{ id: 'edge', sourceNodeId: 'start', targetNodeId: 'display' }], presentation: { panels: [{ nodeId: 'display', title: 'Result', x: 0, y: 0, width: 200, height: 200 }] } })
    const next = patchFlow(original, { removeNodeIds: ['display'] })
    expect(next.edges).toEqual([])
    expect(next.presentation?.panels).toEqual([])
    expect(() => patchFlow(original, { removeNodeIds: ['start'] })).toThrow('Start')
  })

  it('fills inline request defaults and keeps credential masks during partial updates', () => {
    const original = patchFlow(dtoFromFlow(createFlow('Example')), { upsertNodes: [{ id: 'call', kind: 'inlineRequest', request: { endpoint: '{{base}}/users', authentication: { type: 'bearer', token: 'saved' } } }] })
    const edited = patchFlow(original, { upsertNodes: [{ id: 'call', request: { authentication: { type: 'bearer', token: SECRET_MASK } } }] })
    expect(edited.nodes[1]).toMatchObject({ kind: 'inlineRequest', request: { protocol: 'rest', endpoint: '{{base}}/users', headers: [], authentication: { token: 'saved' } } })
  })

  it('rejects repeated upsert ids and implicit node kind changes', () => {
    const original = dtoFromFlow(createFlow('Example'))
    expect(() => patchFlow(original, { upsertNodes: [{ id: 'x', kind: 'log' }, { id: 'x', kind: 'log' }] })).toThrow('Repeated')
    expect(() => patchFlow(original, { upsertNodes: [{ id: 'start', kind: 'log' }] })).toThrow('node kind')
  })

  it('preserves omitted monitor rules and assigns ids to new rules', () => {
    const monitor = { id: 'monitor', name: 'Names', enabled: true, fields: ['name'], rules: [{ id: 'rule', kind: 'notEmpty' as const }] }
    expect(patchMonitor(monitor, { enabled: false }).rules).toEqual(monitor.rules)
    const changed = patchMonitor(monitor, { rules: [{ kind: 'regex', pattern: '^A' }] })
    expect(changed.rules[0]).toMatchObject({ id: expect.any(String), kind: 'regex', pattern: '^A' })
  })
})
