import { describe, expect, it } from 'vitest'
import type { FlowNodeOutputDto } from '../../bindings/get-flow-node-output'
import { childEntries, childrenOfRoot, outputRoots, parseBody, referenceFor, summarize } from './output-tree'

const output = (overrides: Partial<FlowNodeOutputDto> = {}): FlowNodeOutputDto => ({
  statusCode: 200,
  durationMs: 5,
  sizeBytes: 10,
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: '{"data":{"token":"abc","items":[1,2]},"a.b":1}',
  bodyEncoding: 'text',
  truncated: false,
  ...overrides,
})

describe('outputRoots', () => {
  it('exposes gRPC status and message references from live and restored outputs', () => {
    const roots = outputRoots(output({ body: '{"message":"hello"}', headers: [{ name: 'grpc-status', value: '5' }, { name: 'grpc-message', value: 'missing' }] }))
    expect(roots.find((root) => root.key === 'grpcStatus')).toEqual({ key: 'grpcStatus', path: 'grpcStatus', value: { code: 5, codeName: 'NOT_FOUND', message: 'missing' } })
    expect(roots.find((root) => root.key === 'messages')).toEqual({ key: 'messages', path: 'messages', value: [{ message: 'hello' }] })
  })

  it('exposes status, headers and the parsed body', () => {
    const roots = outputRoots(output())
    expect(roots.map((root) => root.key)).toEqual(['status', 'headers', 'body'])
    expect(roots[0]).toMatchObject({ path: 'status', value: 200 })
    expect(roots[1].path).toBeNull()
    expect(roots[2]).toMatchObject({ path: 'body', value: { data: { token: 'abc', items: [1, 2] }, 'a.b': 1 } })
  })

  it('keeps the raw text when the body is not complete JSON', () => {
    expect(parseBody(output({ body: 'plain' }))).toBeUndefined()
    expect(parseBody(output({ truncated: true }))).toBeUndefined()
    expect(outputRoots(output({ body: 'plain' }))[2].value).toBe('plain')
  })
})

describe('childEntries', () => {
  it('builds reference paths through objects and arrays', () => {
    const body = outputRoots(output())[2]
    const data = childEntries(body.value, body.path).find((entry) => entry.key === 'data')!
    expect(data.path).toBe('body.data')
    const items = childEntries(data.value, data.path).find((entry) => entry.key === 'items')!
    expect(childEntries(items.value, items.path).map((entry) => entry.path)).toEqual(['body.data.items.0', 'body.data.items.1'])
  })

  it('marks keys containing a dot as not referenceable', () => {
    const body = outputRoots(output())[2]
    expect(childEntries(body.value, body.path).find((entry) => entry.key === 'a.b')?.path).toBeNull()
  })

  it('uses headers.<name> for each header even though the root is not referenceable', () => {
    const headers = outputRoots(output())[1]
    expect(childrenOfRoot(headers)).toEqual([{ key: 'Content-Type', path: 'headers.Content-Type', value: 'application/json' }])
  })
})

describe('referenceFor and summarize', () => {
  it('builds the template reference', () => {
    expect(referenceFor('n1', 'body.data.token')).toBe('{{nodes.n1.response.body.data.token}}')
  })

  it('summarizes containers and values', () => {
    expect(summarize({ a: 1, b: 2 })).toBe('2 keys')
    expect(summarize([1])).toBe('1 items')
    expect(summarize('hi')).toBe('"hi"')
    expect(summarize(null)).toBe('null')
    expect(summarize(false)).toBe('false')
    expect(summarize('x'.repeat(200))).toHaveLength(83)
  })
})

describe('captured request output', () => {
  it('uses method and path instead of status and references the request', () => {
    const roots = outputRoots({
      statusCode: 0,
      durationMs: 0,
      sizeBytes: 2,
      headers: [{ name: 'x-trace', value: 'abc' }],
      body: '{}',
      bodyEncoding: 'text',
      truncated: false,
      request: { method: 'POST', path: '/users' },
    })
    expect(roots.map((root) => root.key)).toEqual(['method', 'path', 'headers', 'body'])
    expect(referenceFor('wait', 'body.name', 'request')).toBe('{{nodes.wait.request.body.name}}')
  })
})
