import { describe, expect, it } from 'vitest'
import { prepareRequest } from './build-request'
import { replaceKeyedString } from './credentials'
import { applyRouteParameters, resolveTemplate } from './interpolate'
import type { Snapshot, WebclientFolder, WebclientRequest } from './types'

function request(overrides: Partial<WebclientRequest> = {}): WebclientRequest {
  return {
    id: 'r1',
    name: 'Login',
    protocol: 'rest',
    method: 'POST',
    url: '{{baseUrl}}/users/:id?api_key=&page=1',
    headers: [
      { name: 'X-Api-Key', value: '', enabled: true },
      { name: 'X-Disabled', value: 'x', enabled: false },
    ],
    authentication: { type: 'inherit' },
    body: '{"user": "ana", "password": ""}',
    bodyPayload: { type: 'raw', language: 'json' },
    variables: '',
    routeParameters: [{ name: 'id', value: '{{userId}}' }],
    unsupported: [],
    ...overrides,
  }
}

function snapshot(root: WebclientFolder): Snapshot {
  return {
    version: 1,
    exportId: 'e1',
    title: 'API',
    transport: 'auto',
    environment: {
      name: 'Dev',
      variables: [
        { name: 'baseUrl', value: 'https://env.test' },
        { name: 'token', value: '' },
      ],
    },
    credentials: [
      { id: 'variable:token', owner: null, target: { kind: 'variable', name: 'token' }, included: false },
      { id: 'auth', owner: 'Root', target: { kind: 'authentication', nodeId: 'root', field: 'token' }, included: false },
      { id: 'header', owner: 'Login', target: { kind: 'header', nodeId: 'r1', name: 'X-Api-Key' }, included: false },
      { id: 'query', owner: 'Login', target: { kind: 'query', nodeId: 'r1', name: 'api_key' }, included: false },
      { id: 'text', owner: 'Login', target: { kind: 'bodyText', nodeId: 'r1', source: 'body', key: 'password' }, included: false },
    ],
    root,
  }
}

function root(requests: WebclientRequest[] = [request()]): WebclientFolder {
  return {
    id: 'root',
    name: 'Root',
    variables: [
      { name: 'baseUrl', value: 'https://scope.test' },
      { name: 'userId', value: '42' },
    ],
    authentication: { type: 'bearer', token: '' },
    folders: [],
    requests,
  }
}

describe('prepareRequest', () => {
  it('applies credentials before resolving variables', () => {
    const folder = root()
    const prepared = prepareRequest(request(), [folder], snapshot(folder), {
      auth: 'tok-{{userId}}',
      header: 'key-1',
      query: 'q-secret',
      text: 'p"ss',
    })

    expect(prepared).toEqual({
      ok: true,
      oauth2: null,
      call: {
        method: 'POST',
        url: 'https://scope.test/users/42?api_key=q-secret&page=1',
        headers: [
          ['X-Api-Key', 'key-1'],
          ['Authorization', 'Bearer tok-42'],
        ],
        body: { kind: 'text', text: '{"user": "ana", "password": "p\\"ss"}' },
      },
    })
  })

  it('reports variables without value', () => {
    const folder = root([request({ url: '{{missingHost}}/x', routeParameters: [] })])
    const prepared = prepareRequest(folder.requests[0], [folder], snapshot(folder), {})

    expect(prepared).toEqual({ ok: false, error: { kind: 'missingVariables', names: ['missingHost'] } })
  })

  it('builds a GraphQL body without interpolating the query', () => {
    const graphql = request({
      protocol: 'graphql',
      url: 'https://api.test/graphql',
      body: 'query { user(id: "{{userId}}") { id } }',
      variables: '{"id": "{{userId}}"}',
      headers: [],
      routeParameters: [],
      authentication: { type: 'basic', username: 'ana', password: 'pä' },
    })
    const folder = root([graphql])
    const prepared = prepareRequest(graphql, [folder], snapshot(folder), {})

    expect(prepared.ok && prepared.call.body).toEqual({
      kind: 'text',
      text: JSON.stringify({ query: 'query { user(id: "{{userId}}") { id } }', variables: { id: '42' } }),
    })
    expect(prepared.ok && prepared.call.headers).toEqual([
      ['Authorization', `Basic ${btoa('ana:pÃ¤')}`],
      ['Content-Type', 'application/json'],
    ])
  })

  it('refuses unsupported features', () => {
    const binary = request({ bodyPayload: { type: 'binary' }, unsupported: ['binaryBody'] })
    const folder = root([binary])

    expect(prepareRequest(binary, [folder], snapshot(folder), {})).toEqual({
      ok: false,
      error: { kind: 'unsupported', features: ['binaryBody'] },
    })
  })

  it('returns the OAuth2 step and encodes urlencoded bodies', () => {
    const form = request({
      url: 'https://api.test/form',
      headers: [],
      routeParameters: [],
      authentication: { type: 'oauth2ClientCredentials', clientId: 'id', clientSecret: 's', tokenUrl: '{{baseUrl}}/token', scope: '' },
      bodyPayload: {
        type: 'urlEncoded',
        fields: [
          { name: 'a', value: '1 2', enabled: true },
          { name: 'b', value: 'x', enabled: false },
        ],
      },
    })
    const folder = root([form])
    const prepared = prepareRequest(form, [folder], snapshot(folder), {})

    expect(prepared).toEqual({
      ok: true,
      oauth2: { tokenUrl: 'https://scope.test/token', clientId: 'id', clientSecret: 's', scope: '' },
      call: {
        method: 'POST',
        url: 'https://api.test/form',
        headers: [['Content-Type', 'application/x-www-form-urlencoded']],
        body: { kind: 'text', text: 'a=1+2' },
      },
    })
  })
})

describe('helpers', () => {
  it('resolves templates like the backend', () => {
    const variables = new Map([['a', '1']])
    expect(resolveTemplate('{{ a }}-{{b}}-{{c', variables)).toEqual({ text: '1-{{b}}-{{c', missing: ['b'] })
  })

  it('applies route parameters only to the path', () => {
    expect(applyRouteParameters('https://h.test/:id/x?q=/:id#/:id', [{ name: 'id', value: '7' }])).toBe(
      'https://h.test/7/x?q=/:id#/:id',
    )
  })

  it('replaces keyed strings in JSON and GraphQL arguments', () => {
    expect(replaceKeyedString('{"token": "", "other": ""}', 'token', 'a\nb')).toBe('{"token": "a\\nb", "other": ""}')
    expect(replaceKeyedString('login(password: "")', 'password', 'x')).toBe('login(password: "x")')
  })
})
