import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isShellCommand, readShellRequest } from './shell-paste-import'

const importCollectionsFromText = vi.fn()

vi.mock('../../bindings/import-collections-from-text', () => ({
  importCollectionsFromText: (...args: unknown[]) => importCollectionsFromText(...args),
}))

const request = (name: string, endpoint: string) => ({
  id: name,
  name,
  protocol: 'rest',
  endpoint,
  method: 'post',
  body: '{"a":1}',
  restBody: { type: 'raw', rawLanguage: 'json', content: '{"a":1}' },
  variables: '',
  headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
  authentication: { type: 'none' },
  preRequestScript: '',
  postResponseScript: '',
})

const collection = (requests: unknown[]) => ({
  id: 'c',
  name: 'api.test',
  folders: [],
  requests,
  authentication: { type: 'none' },
})

describe('shell-paste-import', () => {
  beforeEach(() => importCollectionsFromText.mockReset())

  it('reconhece comandos curl e wget, com prompt, espaços e comentários antes', () => {
    expect(isShellCommand('curl https://api.test')).toBe(true)
    expect(isShellCommand('  curl -X POST https://api.test')).toBe(true)
    expect(isShellCommand('$ curl https://api.test')).toBe(true)
    expect(isShellCommand('\n# buscar usuários\ncurl https://api.test')).toBe(true)
    expect(isShellCommand('wget https://api.test')).toBe(true)
    expect(isShellCommand('curl')).toBe(true)
    expect(isShellCommand('grpcurl -plaintext grpcb.in:9000 HelloService/SayHello')).toBe(true)
    expect(isShellCommand('# exported call\n$ grpcurl host:443 pkg.Service/Call')).toBe(true)
    expect(isShellCommand('/usr/local/bin/grpcurl -d "{}" host:443 pkg.Service/Call')).toBe(true)
    expect(isShellCommand('C:\\tools\\grpcurl.exe host:443 pkg.Service/Call')).toBe(true)
  })

  it('não trata URL nem texto comum como comando', () => {
    expect(isShellCommand('https://api.test/curl')).toBe(false)
    expect(isShellCommand('curly braces')).toBe(false)
    expect(isShellCommand('grpcurlish host:443')).toBe(false)
    expect(isShellCommand('grpcs://grpcurl:443')).toBe(false)
    expect(isShellCommand('{{baseUrl}}/users')).toBe(false)
    expect(isShellCommand('   ')).toBe(false)
  })

  it('devolve o conteúdo da primeira requisição do comando', async () => {
    importCollectionsFromText.mockResolvedValue({
      ok: true,
      value: { collections: [collection([request('a', 'https://api.test/a'), request('b', 'https://api.test/b')])], environments: [] },
    })

    const result = await readShellRequest('curl https://api.test/a', '/ws')

    expect(importCollectionsFromText).toHaveBeenCalledWith('curl https://api.test/a', '/ws')
    expect(result).toMatchObject({
      ok: true,
      content: {
        protocol: 'rest',
        method: 'post',
        endpointUrl: 'https://api.test/a',
        headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
        body: { type: 'raw', rawLanguage: 'json', content: '{"a":1}' },
      },
    })
  })

  it('repassa o erro do parser e avisa quando não há requisição', async () => {
    importCollectionsFromText.mockResolvedValueOnce({ ok: false, error: { kind: 'invalid', message: 'aspas não fechadas' } })
    expect(await readShellRequest("curl 'https://api.test", '/ws')).toEqual({ ok: false, message: 'aspas não fechadas' })

    importCollectionsFromText.mockResolvedValueOnce({ ok: true, value: { collections: [collection([])], environments: [] } })
    expect(await readShellRequest('curl https://api.test', '/ws')).toEqual({ ok: false, message: null })
  })

  it('preserves gRPC schema, deadline, JSON and metadata from the native importer', async () => {
    importCollectionsFromText.mockResolvedValue({ ok: true, value: { collections: [collection([{
      ...request('rpc', 'grpcs://api.test:8443'),
      protocol: 'grpc', body: '{"name":"Ana"}',
      headers: [{ name: 'x-id', value: '42', enabled: true }],
      grpc: { service: 'test.Greeter', method: 'Hello', deadlineMs: 2500,
        schemaSource: { type: 'protoFiles', files: ['hello.proto'], importPaths: ['protos'] } },
    }])], environments: [] } })

    const result = await readShellRequest('grpcurl -proto hello.proto api.test:8443 test.Greeter/Hello', '/ws')

    expect(result).toMatchObject({ ok: true, content: {
      protocol: 'grpc', endpointUrl: 'grpcs://api.test:8443',
      query: '', variables: '',
      headers: [{ name: 'x-id', value: '42', enabled: true }],
      grpc: { service: 'test.Greeter', method: 'Hello', message: '{"name":"Ana"}', deadlineMs: 2500,
        schemaSource: { type: 'protoFiles', files: ['hello.proto'], importPaths: ['protos'] } },
    } })
  })
})
