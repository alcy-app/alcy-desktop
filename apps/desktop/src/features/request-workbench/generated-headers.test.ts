import { describe, expect, it } from 'vitest'
import type { HttpMethodInput } from '../../bindings/execute-rest-request'
import { defaultGeneratedHeaders } from './generated-headers'
import type { BodyState, HeaderEntry } from './request-workbench.types'

const emptyBody: BodyState = {
  type: 'none',
  raw: '',
  rawLanguage: 'json',
  urlEncoded: [],
  formData: [],
  binaryFilePath: '',
}

const build = (
  overrides: { body?: Partial<BodyState>; headers?: HeaderEntry[]; endpointUrl?: string; method?: HttpMethodInput } = {},
) =>
  defaultGeneratedHeaders({
    endpointUrl: overrides.endpointUrl ?? 'https://api.example.com/users',
    method: overrides.method ?? 'get',
    body: { ...emptyBody, ...overrides.body },
    headers: overrides.headers ?? [],
    onSendValue: '<gerado no envio>',
    reason: 'motivo',
  })

describe('defaultGeneratedHeaders', () => {
  it('lista os headers padrão sem Content-Length quando não há corpo', () => {
    const names = build().map((header) => header.name)
    expect(names).toEqual(['User-Agent', 'Accept', 'Cache-Control', 'Accept-Encoding', 'Host', 'Connection'])
  })

  it('deriva o Host da URL e cai no valor de envio quando a URL não é válida', () => {
    expect(build().find((header) => header.name === 'Host')?.value).toBe('api.example.com')
    expect(build({ endpointUrl: '{{baseUrl}}/x' }).find((header) => header.name === 'Host')?.value).toBe(
      '<gerado no envio>',
    )
  })

  it('inclui Content-Type e Content-Length quando há corpo', () => {
    const headers = build({ method: 'post', body: { type: 'raw', raw: '{}', rawLanguage: 'xml' } })
    expect(headers.find((header) => header.name === 'Content-Type')?.value).toBe('application/xml')
    expect(headers.find((header) => header.name === 'Content-Length')?.value).toBe('<gerado no envio>')
  })

  it('usa o Content-Type de urlencoded e deixa binary para o envio', () => {
    const urlEncoded = build({
      body: { type: 'urlencoded', urlEncoded: [{ id: '1', name: 'a', value: 'b', enabled: true }] },
    })
    expect(urlEncoded.find((header) => header.name === 'Content-Type')?.value).toBe(
      'application/x-www-form-urlencoded',
    )
    const binary = build({ body: { type: 'binary', binaryFilePath: '/tmp/foto.png' } })
    expect(binary.find((header) => header.name === 'Content-Type')?.value).toBe('<gerado no envio>')
  })

  it('envia Content-Length 0 em POST/PUT/PATCH sem corpo, mas não em GET', () => {
    for (const method of ['post', 'put', 'patch'] as const) {
      const headers = build({ method })
      expect(headers.find((header) => header.name === 'Content-Length')?.value).toBe('0')
      expect(headers.map((header) => header.name)).not.toContain('Content-Type')
    }
    expect(build({ method: 'get' }).map((header) => header.name)).not.toContain('Content-Length')
  })

  it('omite o Content-Type automático quando o usuário define um', () => {
    const headers: HeaderEntry[] = [{ id: '1', name: 'content-type', value: 'application/vnd.api+json', enabled: true }]
    const names = build({ body: { type: 'raw', raw: '{}' }, headers }).map((header) => header.name)
    expect(names).not.toContain('Content-Type')
    expect(names).toContain('Content-Length')
  })

  it('omite o header que o usuário habilitou, ignorando maiúsculas', () => {
    const headers: HeaderEntry[] = [
      { id: '1', name: 'user-agent', value: 'x', enabled: true },
      { id: '2', name: 'Accept', value: 'y', enabled: false },
    ]
    const names = build({ headers }).map((header) => header.name)
    expect(names).not.toContain('User-Agent')
    expect(names).toContain('Accept')
  })
})
