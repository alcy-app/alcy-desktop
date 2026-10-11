import { describe, expect, it } from 'vitest'
import type { ExecuteGraphqlRequestOutput } from '../../../bindings/execute-graphql-request'
import type { ExecuteRestRequestOutput } from '../../../bindings/execute-rest-request'
import { SENSITIVE_MASK } from '../../environments/environments.types'
import { emptyAuthorizationState } from '../authorization-state'
import { emptyBodyState } from '../body-state'
import type { SnippetTab } from '../code-snippets/snippet-request'
import type { ExecutionState } from '../request-workbench.types'
import {
  buildScreenshotContent,
  isScreenshotEmpty,
  type ScreenshotCodeBlock,
  type ScreenshotContent,
  type ScreenshotContentText,
  type ScreenshotSource,
} from './screenshot-content'
import { DEFAULT_SCREENSHOT_OPTIONS, type ScreenshotOptions } from './screenshot-options'

const restTab: SnippetTab = {
  protocol: 'rest',
  method: 'post',
  endpointUrl: '{{baseUrl}}/users/:userId/:secret?key={{apiKey}}',
  query: '',
  variables: '',
  headers: [{ id: 'h1', name: 'X-Trace', value: '{{apiKey}}-trace', enabled: true }],
  routeParams: [
    { id: 'route-user', name: 'userId', value: '42' },
    { id: 'route-secret', name: 'secret', value: '{{apiKey}}' },
  ],
  body: { ...emptyBodyState, type: 'raw', raw: '{"name":"Ana"}', rawLanguage: 'json' },
  authorization: { ...emptyAuthorizationState, type: 'bearer', token: '{{apiKey}}' },
}

const variables = [
  { name: 'baseUrl', value: 'https://api.test', sensitive: false },
  { name: 'apiKey', value: 's3cr3t', sensitive: true },
]

function restResult(overrides: Partial<ExecuteRestRequestOutput> = {}): ExecuteRestRequestOutput {
  return {
    statusCode: 201,
    durationMs: 42,
    sizeBytes: 1500,
    body: { kind: 'inline', body: '{"id":1,"name":"Ana"}' },
    bodyEncoding: 'text',
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Set-Cookie', value: 'sid=abc; Path=/' },
    ],
    requestHeaders: [
      { name: 'Authorization', value: 'Bearer s3cr3t' },
      { name: 'X-Trace', value: 's3cr3t-trace' },
    ],
    cookies: [],
    connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
    finalUrl: null,
    waitingMs: 10,
    environmentChanges: [],
    scopedChanges: [],
    scriptLogs: [],
    scriptError: null,
    testResults: [],
    ...overrides,
  }
}

const text: ScreenshotContentText = {
  capturedAt: '26/09/2026 14:32',
  errorMessage: (error) => `falhou: ${error.kind}`,
  binaryBody: (size) => `[binário ${size}]`,
  emptyBody: '(vazio)',
  previewOnly: (shown, total) => `prévia ${shown} de ${total}`,
  file: (path) => `arquivo: ${path}`,
}

const allFields = Object.fromEntries(
  Object.keys(DEFAULT_SCREENSHOT_OPTIONS.fields).map((field) => [field, true]),
) as ScreenshotOptions['fields']

function build(
  execution: ExecutionState,
  overrides: Partial<ScreenshotOptions> = {},
  source: Partial<ScreenshotSource> = {},
): ScreenshotContent {
  return buildScreenshotContent(
    {
      tab: restTab,
      execution,
      inheritedAuthentication: undefined,
      environmentVariables: variables,
      requestName: 'Criar usuário',
      environmentName: 'Homologação',
      ...source,
    },
    { ...DEFAULT_SCREENSHOT_OPTIONS, fields: allFields, ...overrides },
    text,
  )
}

const success = (result: ExecuteRestRequestOutput | ExecuteGraphqlRequestOutput): ExecutionState => ({ status: 'success', result })

function responseBody(content: ScreenshotContent): ScreenshotCodeBlock {
  if (content.response?.kind !== 'success' || content.response.body?.kind !== 'code') throw new Error('sem corpo de resposta')
  return content.response.body
}

describe('buildScreenshotContent', () => {
  it('monta cabeçalho, URL e status da execução', () => {
    const content = build(success(restResult()))

    expect(content.header).toEqual({ title: 'Criar usuário', environment: 'Homologação', capturedAt: '26/09/2026 14:32' })
    expect(content.endpoint).toEqual({ method: 'POST', url: 'https://api.test/users/42/{{apiKey}}?key={{apiKey}}' })
    expect(content.response).toMatchObject({
      kind: 'success',
      status: { statusCode: 201, tone: 'success', graphql: null, duration: '42 ms', size: '1.5 KB' },
    })
  })

  it('oculta credenciais e variáveis sensíveis por padrão', () => {
    const content = build(success(restResult()))

    expect(content.request?.headers).toEqual([
      { name: 'Authorization', value: `Bearer ${SENSITIVE_MASK}` },
      { name: 'X-Trace', value: '{{apiKey}}-trace' },
    ])
    expect(content.response?.kind === 'success' && content.response.headers).toContainEqual({
      name: 'Set-Cookie',
      value: `sid=${SENSITIVE_MASK}; Path=/`,
    })
  })

  it('mostra os valores reais com a ocultação desligada', () => {
    const content = build(success(restResult()), { hideSensitive: false })

    expect(content.endpoint?.url).toBe('https://api.test/users/42/s3cr3t?key=s3cr3t')
    expect(content.request?.headers).toContainEqual({ name: 'Authorization', value: 'Bearer s3cr3t' })
  })

  it('sem execução, usa os headers configurados e deixa a resposta de fora', () => {
    const content = build({ status: 'idle' })

    expect(content.request?.headers).toEqual([
      { name: 'X-Trace', value: '{{apiKey}}-trace' },
      { name: 'Authorization', value: `Bearer ${SENSITIVE_MASK}` },
    ])
    expect(content.response).toBeNull()
  })

  it('mostra a falha da execução no lugar da resposta', () => {
    const content = build({ status: 'error', error: { kind: 'timeout' } })
    expect(content.response).toEqual({ kind: 'error', message: 'falhou: timeout' })
  })

  it('formata o JSON da requisição e da resposta', () => {
    const content = build(success(restResult()))

    expect(content.request?.body).toEqual([
      expect.objectContaining({ kind: 'code', label: 'Body', language: 'json', lines: ['{', '  "name": "Ana"', '}'] }),
    ])
    expect(responseBody(content).lines).toEqual(['{', '  "id": 1,', '  "name": "Ana"', '}'])
  })

  it('corta o corpo no limite de linhas e conta o restante', () => {
    const items = Array.from({ length: 40 }, (_, index) => index)
    const content = build(success(restResult({ body: { kind: 'inline', body: JSON.stringify(items) } })), { lineLimit: '30' })

    const body = responseBody(content)
    expect(body.lines).toHaveLength(30)
    expect(body.omittedLines).toBe(12) // 40 itens + colchetes = 42 linhas
  })

  it('usa só a prévia de um corpo grande, com aviso', () => {
    const body = {
      kind: 'windowed' as const,
      handle: 'h',
      totalBytes: 3_000_000,
      preview: '{"items":[{"id":1},{"id":2',
      previewNextOffset: 200_000,
    }
    const content = build(success(restResult({ body })))

    const block = responseBody(content)
    expect(block.lines[0]).toBe('{')
    expect(block.note).toBe('prévia 200 KB de 3.0 MB')
  })

  it('troca corpo binário por um marcador', () => {
    const content = build(success(restResult({ bodyEncoding: 'base64', body: { kind: 'inline', body: 'iVBORw0K' } })))
    expect(responseBody(content).lines).toEqual(['[binário 1.5 KB]'])
  })

  it('separa query e variables do GraphQL e marca erros GraphQL', () => {
    const graphqlTab: SnippetTab = {
      ...restTab,
      protocol: 'graphql',
      endpointUrl: '{{baseUrl}}/graphql',
      query: 'query { me { id } }',
      variables: '{"id":"1"}',
      authorization: { ...emptyAuthorizationState, type: 'none' },
    }
    const result: ExecuteGraphqlRequestOutput = {
      ...restResult(),
      graphqlErrors: [{ message: 'boom', path: [], locations: [] }],
    }
    const content = build(success(result), {}, { tab: graphqlTab })

    expect(content.request?.body).toEqual([
      expect.objectContaining({ label: 'Query', language: 'graphql', lines: ['query { me { id } }'] }),
      expect.objectContaining({ label: 'Variables', language: 'json', lines: ['{', '  "id": "1"', '}'] }),
    ])
    expect(content.response?.kind === 'success' && content.response.status?.graphql).toBe('error')
  })

  it('lista campos de form-data, com arquivos pelo caminho', () => {
    const tab: SnippetTab = {
      ...restTab,
      body: {
        ...emptyBodyState,
        type: 'formData',
        formData: [
          { id: 'f1', name: 'nome', value: 'Ana', enabled: true, kind: 'text', filePath: '' },
          { id: 'f2', name: 'foto', value: '', enabled: true, kind: 'file', filePath: '/tmp/foto.png' },
        ],
      },
    }
    const content = build({ status: 'idle' }, {}, { tab })

    expect(content.request?.body).toEqual([
      {
        kind: 'table',
        label: 'Body',
        rows: [
          { name: 'nome', value: 'Ana' },
          { name: 'foto', value: 'arquivo: /tmp/foto.png' },
        ],
      },
    ])
  })

  it('fica vazio com todos os campos desligados', () => {
    const fields = Object.fromEntries(Object.keys(allFields).map((field) => [field, false])) as ScreenshotOptions['fields']
    expect(isScreenshotEmpty(build(success(restResult()), { fields }))).toBe(true)
  })
})
