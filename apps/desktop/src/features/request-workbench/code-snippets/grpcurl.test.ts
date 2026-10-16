import { describe, expect, it } from 'vitest'
import { emptyAuthorizationState } from '../authorization-state'
import { emptyBodyState } from '../body-state'
import { emptyGrpcCall } from '../collection-tree'
import { generateGrpcurlSnippet } from './grpcurl'
import { buildSnippetRequest, type SnippetTab } from './snippet-request'

const tab: SnippetTab = {
  protocol: 'grpc', method: 'post', endpointUrl: 'localhost:50051', query: 'stale query', variables: '',
  body: { ...emptyBodyState, raw: 'stale HTTP body' }, routeParams: [],
  headers: [{ id: 'on', name: 'x-id', value: '{{id}}', enabled: true }, { id: 'off', name: 'x-off', value: 'skip', enabled: false }],
  authorization: { ...emptyAuthorizationState, type: 'inherit' },
  grpc: { ...emptyGrpcCall, service: 'test.Greeter', method: 'Hello', message: '{"name":"{{name}}","token":"{{token}}"}' },
}

function generate(overrides: Partial<SnippetTab> = {}) {
  return generateGrpcurlSnippet(buildSnippetRequest({ ...tab, ...overrides }, { type: 'bearer', token: '{{token}}' }, [
    { name: 'name', value: "O'Brien", sensitive: false },
    { name: 'token', value: 'do-not-export', sensitive: true },
    { name: 'id', value: '42', sensitive: false },
  ]))
}

describe('grpcurl snippets', () => {
  it('uses the gRPC message and metadata, inherits auth, quotes shell text and preserves sensitive placeholders', () => {
    const code = generate()
    expect(code).toContain('grpcurl -plaintext')
    expect(code).toContain("-H 'x-id: 42'")
    expect(code).toContain("-H 'Authorization: Bearer {{token}}'")
    expect(code).toContain(`-d '{"name":"O'\\''Brien","token":"{{token}}"}'`)
    expect(code).toContain("'localhost:50051'")
    expect(code).toContain("'test.Greeter/Hello'")
    for (const absent of ['stale query', 'stale HTTP body', 'x-off', 'do-not-export', 'Content-Type', '-proto']) expect(code).not.toContain(absent)
  })

  it.each([
    ['https://api.test', 'api.test:443', false],
    ['grpcs://api.test:8443/', 'api.test:8443', false],
    ['api.test:443', 'api.test:443', false],
    ['grpc://api.test', 'api.test:80', true],
    ['http://[::1]:50051/', '[::1]:50051', true],
    ['api.test', 'api.test:80', true],
  ])('matches the desktop TLS and port rules for %s', (endpointUrl, address, plaintext) => {
    const code = generate({ endpointUrl })
    expect(code.includes('-plaintext')).toBe(plaintext)
    expect(code).toContain(`'${address}'`)
    expect(code).not.toContain('://')
  })

  it('includes local schema paths and converts the deadline to seconds', () => {
    const code = generate({ grpc: { ...emptyGrpcCall, service: 'test.Greeter', method: 'Hello', deadlineMs: 2500,
      schemaSource: { type: 'protoFiles', files: ['protos/hello.proto', "protos/O'Brien.proto"], importPaths: ['protos', 'third party'] } } })
    expect(code).toContain("-proto 'protos/hello.proto'")
    expect(code).toContain("-proto 'protos/O'\\''Brien.proto'")
    expect(code).toContain("-import-path '.'")
    expect(code).toContain("-import-path 'third party'")
    expect(code).toContain('-max-time 2.5')
  })

  it.each([
    ['protos/hello.proto', 'protos'],
    ['/hello.proto', '/'],
    ['C:\\hello.proto', 'C:/'],
  ])('includes the parent directory of %s for imports', (file, directory) => {
    const code = generate({ grpc: { ...emptyGrpcCall,
      schemaSource: { type: 'protoFiles', files: [file], importPaths: [] } } })
    expect(code).toContain(`-import-path '${directory}'`)
  })
})
