import { describe, expect, it } from 'vitest'
import { emptyAuthorizationState } from '../authorization-state'
import { emptyBodyState } from '../body-state'
import type { SnippetTab } from '../code-snippets/snippet-request'
import {
  buildImportCollection,
  clearSuspectedPasswordsForImport,
  hasSuspectedPasswordInImportMetadata,
  type ImportMetadataInput,
} from './import-metadata'

const restTab: SnippetTab = {
  protocol: 'rest',
  method: 'post',
  endpointUrl: '{{baseUrl}}/users',
  query: '',
  variables: '',
  routeParams: [],
  headers: [
    { id: 'h1', name: 'X-Trace', value: '{{traceId}}', enabled: true },
    { id: 'h2', name: 'X-Api-Key', value: 'chave-literal', enabled: true },
    { id: 'h3', name: 'Authorization', value: 'Bearer {{token}}', enabled: false },
  ],
  body: { ...emptyBodyState, type: 'raw', raw: '{"name":"Ada"}', rawLanguage: 'json' },
  authorization: { ...emptyAuthorizationState, type: 'bearer', token: 'segredo-digitado' },
}

function build(overrides: Partial<ImportMetadataInput> = {}) {
  return buildImportCollection({
    tab: restTab,
    inheritedAuthentication: undefined,
    requestName: 'Criar usuário',
    hideSensitive: false,
    ...overrides,
  })
}

describe('buildImportCollection', () => {
  it('leva a requisição com variáveis, sem scripts', () => {
    const collection = build()
    const [request] = collection.requests

    expect(collection.name).toBe('Criar usuário')
    expect(request).toMatchObject({
      name: 'Criar usuário',
      protocol: 'rest',
      endpoint: '{{baseUrl}}/users',
      method: 'post',
      body: '{"name":"Ada"}',
      restBody: { type: 'raw', content: '{"name":"Ada"}', rawLanguage: 'json' },
      authentication: { type: 'bearer', token: 'segredo-digitado' },
      preRequestScript: '',
      postResponseScript: '',
    })
    expect(request.headers).toEqual([
      { name: 'X-Trace', value: '{{traceId}}', enabled: true },
      { name: 'X-Api-Key', value: 'chave-literal', enabled: true },
      { name: 'Authorization', value: 'Bearer {{token}}', enabled: false },
    ])
  })

  it('não leva valores de variáveis', () => {
    expect(build().variables).toEqual([])
  })

  it('com dados sensíveis ocultos, remove só os segredos digitados', () => {
    const [request] = build({ hideSensitive: true }).requests

    expect(request.authentication).toEqual({ type: 'bearer', token: '' })
    expect(request.headers).toEqual([
      { name: 'X-Trace', value: '{{traceId}}', enabled: true },
      { name: 'X-Api-Key', value: '', enabled: true },
      { name: 'Authorization', value: 'Bearer {{token}}', enabled: false },
    ])
  })

  it('troca a autenticação herdada pela efetiva', () => {
    const tab = { ...restTab, authorization: { ...emptyAuthorizationState, type: 'inherit' as const } }

    expect(build({ tab }).requests[0].authentication).toEqual({ type: 'none' })
    expect(
      build({ tab, inheritedAuthentication: { type: 'basic', username: 'ada', password: '{{senha}}' }, hideSensitive: true })
        .requests[0].authentication,
    ).toEqual({ type: 'basic', username: 'ada', password: '{{senha}}' })
  })

  it('leva query e variables de uma requisição GraphQL', () => {
    const tab: SnippetTab = {
      ...restTab,
      protocol: 'graphql',
      endpointUrl: 'https://api.test/graphql',
      query: 'query { me { id } }',
      variables: '{"id": 1}',
      headers: [],
      authorization: { ...emptyAuthorizationState },
    }

    const [request] = build({ tab }).requests

    expect(request).toMatchObject({ protocol: 'graphql', body: 'query { me { id } }', variables: '{"id": 1}', restBody: null })
  })
})

describe('hasSuspectedPasswordInImportMetadata', () => {
  const inspect = (
    tab: SnippetTab,
    environmentVariables: Array<{ name: string; value: string; sensitive: boolean }> = [],
    inheritedAuthentication: ImportMetadataInput['inheritedAuthentication'] = undefined,
  ) => hasSuspectedPasswordInImportMetadata({ tab, environmentVariables, inheritedAuthentication })

  it('detecta credenciais pela autenticação e por nomes de campos preenchidos', () => {
    expect(inspect(restTab)).toBe(true)

    const withPasswordBody: SnippetTab = {
      ...restTab,
      headers: [],
      authorization: { ...emptyAuthorizationState },
      body: { ...emptyBodyState, type: 'raw', raw: '{"user":"ada","password":"abc"}', rawLanguage: 'json' },
    }
    expect(inspect(withPasswordBody)).toBe(true)
  })

  it('detecta o valor literal de uma variável sensível em campo de nome neutro', () => {
    const neutralTab: SnippetTab = {
      ...restTab,
      headers: [{ id: 'h1', name: 'X-Config', value: 'prefixo-chave-secreta', enabled: true }],
      authorization: { ...emptyAuthorizationState },
      body: { ...emptyBodyState, type: 'raw', raw: '{"config":"normal"}', rawLanguage: 'json' },
    }
    const variables = [{ name: 'senhaApi', value: 'chave-secreta', sensitive: true }]

    expect(inspect(neutralTab, variables)).toBe(true)
  })

  it('não alerta nem esvazia referências a variáveis marcadas como sensíveis', () => {
    const variables = [{ name: 'senhaApi', value: 'chave-secreta', sensitive: true }]
    const tabWithSensitiveReferences: SnippetTab = {
      ...restTab,
      endpointUrl: 'https://api.test/login?password={{senhaApi}}',
      headers: [{ id: 'h1', name: 'Authorization', value: 'Bearer {{senhaApi}}', enabled: true }],
      authorization: { ...emptyAuthorizationState, type: 'bearer', token: '{{senhaApi}}' },
      body: { ...emptyBodyState, type: 'raw', raw: '{"password":"{{senhaApi}}"}', rawLanguage: 'json' },
    }

    expect(inspect(tabWithSensitiveReferences, variables)).toBe(false)
    expect(
      clearSuspectedPasswordsForImport({
        tab: tabWithSensitiveReferences,
        inheritedAuthentication: undefined,
        environmentVariables: variables,
      }).tab,
    ).toMatchObject({
      endpointUrl: 'https://api.test/login?password={{senhaApi}}',
      headers: [{ value: 'Bearer {{senhaApi}}' }],
      authorization: { token: '{{senhaApi}}' },
      body: { raw: '{"password":"{{senhaApi}}"}' },
    })
  })

  it('não alerta para campos comuns nem para nomes sensíveis vazios', () => {
    const safeTab: SnippetTab = {
      ...restTab,
      headers: [{ id: 'h1', name: 'X-Trace', value: 'trace-1', enabled: true }],
      authorization: { ...emptyAuthorizationState },
      body: { ...emptyBodyState, type: 'urlencoded', urlEncoded: [{ id: 'f1', name: 'password', value: '', enabled: true }] },
    }

    expect(inspect(safeTab)).toBe(false)
  })

  it('esvazia os campos suspeitos somente na fonte usada pelos metadados', () => {
    const sourceTab: SnippetTab = {
      ...restTab,
      endpointUrl: 'https://api.test/login?password=abc&mode=full',
      headers: [
        { id: 'h1', name: 'X-Api-Key', value: 'abc', enabled: true },
        { id: 'h2', name: 'X-Trace', value: 'trace-1', enabled: true },
      ],
      authorization: { ...emptyAuthorizationState },
      body: {
        ...emptyBodyState,
        type: 'raw',
        raw: '{"user":"ada","password":"abc","nested":{"token":"def"}}',
        rawLanguage: 'json',
      },
    }

    const cleared = clearSuspectedPasswordsForImport({
      tab: sourceTab,
      inheritedAuthentication: undefined,
      environmentVariables: [],
    })

    expect(cleared.tab.endpointUrl).toBe('https://api.test/login?password=&mode=full')
    expect(cleared.tab.headers).toEqual([
      { id: 'h1', name: 'X-Api-Key', value: '', enabled: true },
      { id: 'h2', name: 'X-Trace', value: 'trace-1', enabled: true },
    ])
    expect(cleared.tab.body).toMatchObject({ raw: '{"user":"ada","password":"","nested":{"token":""}}' })
    expect(sourceTab.body).toMatchObject({ raw: '{"user":"ada","password":"abc","nested":{"token":"def"}}' })
  })

  it('preserva a query GraphQL e esvazia a variável de senha', () => {
    const query = 'mutation Login($password: String!) { login(password: $password) }'
    const graphqlTab: SnippetTab = {
      ...restTab,
      protocol: 'graphql',
      query,
      variables: '{"password":"abc"}',
      headers: [],
      authorization: { ...emptyAuthorizationState },
    }

    const cleared = clearSuspectedPasswordsForImport({
      tab: graphqlTab,
      inheritedAuthentication: undefined,
      environmentVariables: [],
    })

    expect(cleared.tab.query).toBe(query)
    expect(cleared.tab.variables).toBe('{"password":""}')
  })
})
