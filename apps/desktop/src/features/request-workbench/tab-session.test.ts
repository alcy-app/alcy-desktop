import { describe, expect, it } from 'vitest'
import { emptyRequestContent } from './collection-tree'
import type { RequestContent, TreeNode } from './collection-tree'
import type { WorkbenchTab } from './request-workbench.types'
import { parseTabSession, resolveTabSession, sessionFromLegacy, snapshotTabSession } from './tab-session'
import type { TabSession } from './tab-session'

function content(overrides: Partial<RequestContent> = {}): RequestContent {
  return {
    ...emptyRequestContent('graphql'),
    endpointUrl: 'https://api.example.com/graphql',
    query: 'query { ping }',
    ...overrides,
  }
}

function tab(overrides: Partial<WorkbenchTab> = {}): WorkbenchTab {
  const savedContent = overrides.savedContent ?? content()
  return {
    id: 'tab-1',
    requestId: 'request-1',
    name: 'Ping',
    pinned: true,
    endpointUrl: savedContent.endpointUrl,
    activeSection: 'query',
    protocol: savedContent.protocol,
    method: savedContent.method,
    query: savedContent.query,
    variables: savedContent.variables,
    body: {
      type: 'raw',
      raw: '',
      rawLanguage: 'json',
      urlEncoded: [],
      formData: [],
      binaryFilePath: '',
    },
    preRequestScript: savedContent.preRequestScript,
    postResponseScript: savedContent.postResponseScript,
    headers: [],
    params: [],
    routeParams: [],
    authorization: {
      type: 'inherit',
      headerName: '',
      headerValue: '',
      token: '',
      username: '',
      password: '',
      clientId: '',
      clientSecret: '',
      tokenUrl: '',
      scope: '',
    },
    savedContent,
    dirty: false,
    execution: { status: 'idle' },
    executionId: null,
    lastSendId: null,
    schema: { status: 'idle' },
    grpc: savedContent.grpc,
    grpcSchema: { status: 'idle' },
    schemaExecutionId: null,
    ...overrides,
  }
}

function contentOfTab(value: WorkbenchTab): RequestContent {
  return {
    ...value.savedContent,
    endpointUrl: value.endpointUrl,
    query: value.query,
    variables: value.variables,
    preRequestScript: value.preRequestScript,
    postResponseScript: value.postResponseScript,
  }
}

function collectionsWith(requestContent: RequestContent): TreeNode[] {
  return [
    {
      id: 'collection-1',
      name: 'API',
      folders: [],
      requests: [{ id: 'request-1', name: 'Ping atual', protocol: requestContent.protocol, content: requestContent }],
      authentication: { type: 'inherit' },
      variables: [],
    },
  ]
}

describe('snapshotTabSession', () => {
  it('preserva ordem e aba ativa, guardando conteúdo apenas quando há alterações', () => {
    const draft = tab({
      id: 'draft',
      requestId: null,
      name: 'Rascunho',
      query: 'query { draft }',
      dirty: true,
    })
    const saved = tab({ id: 'saved', requestId: 'request-1', dirty: false })
    const edited = tab({ id: 'edited', requestId: 'request-2', query: 'query { edited }', dirty: true })

    const snapshot = snapshotTabSession([draft, saved, edited], 'saved', contentOfTab)

    expect(snapshot.activeTabId).toBe('saved')
    expect(snapshot.tabs).toEqual([
      { id: 'draft', requestId: null, name: 'Rascunho', draft: expect.objectContaining({ query: 'query { draft }' }) },
      { id: 'saved', requestId: 'request-1', name: 'Ping', draft: null },
      { id: 'edited', requestId: 'request-2', name: 'Ping', draft: expect.objectContaining({ query: 'query { edited }' }) },
    ])
  })

  it('ignora pré-visualização de histórico e aba de node de flow', () => {
    const historyPreview = tab({ id: 'history', requestId: null, pinned: false, dirty: false })
    const flowNode = tab({ id: 'flow', flowNodeRef: { flowId: 'flow-1', nodeId: 'node-1' }, dirty: true })
    const savedPreview = tab({ id: 'saved-preview', pinned: false })

    expect(snapshotTabSession([historyPreview, flowNode, savedPreview], 'history', contentOfTab)).toEqual({
      version: 1,
      activeTabId: null,
      tabs: [{ id: 'saved-preview', requestId: 'request-1', name: 'Ping', draft: null }],
    })
  })

  it('não muda quando apenas o estado de execução da aba muda', () => {
    const beforeSend = tab()
    const duringSend = tab({ execution: { status: 'loading', startedAt: 0 }, executionId: 'send-1' })

    expect(snapshotTabSession([duringSend], 'tab-1', contentOfTab)).toEqual(
      snapshotTabSession([beforeSend], 'tab-1', contentOfTab),
    )
  })
})

describe('parseTabSession', () => {
  it('completa campos aditivos com os padrões do protocolo', () => {
    const parsed = parseTabSession({
      version: 1,
      activeTabId: 'draft',
      tabs: [{ id: 'draft', requestId: null, name: 'Rascunho', draft: { protocol: 'rest' }, futureField: true }],
    })

    expect(parsed).toEqual({
      activeTabId: 'draft',
      tabs: [
        {
          id: 'draft',
          requestId: null,
          name: 'Rascunho',
          draft: emptyRequestContent('rest'),
        },
      ],
    })
  })

  it('descarta entradas inválidas e ids repetidos sem perder as válidas', () => {
    const parsed = parseTabSession({
      version: 1,
      activeTabId: 'missing',
      tabs: [
        { id: '', requestId: 'request-empty-id', draft: null },
        { id: 'invalid-method', requestId: null, draft: { protocol: 'rest', method: 'trace' } },
        {
          id: 'invalid-body',
          requestId: null,
          draft: { protocol: 'rest', body: { type: 'urlencoded', fields: [{ name: 'a', value: 'b' }] } },
        },
        { id: 'saved', requestId: 'request-1', name: 'Ping', draft: null },
        { id: 'saved', requestId: 'request-2', name: 'Duplicada', draft: null },
        { id: 'draft', requestId: null, name: 'Rascunho', draft: { protocol: 'graphql' } },
      ],
    })

    expect(parsed?.activeTabId).toBeNull()
    expect(parsed?.tabs.map((entry) => entry.id)).toEqual(['saved', 'draft'])
  })

  it('trata envelope corrompido ou de versão desconhecida como sessão vazia', () => {
    expect(parseTabSession(null)).toBeNull()
    expect(parseTabSession({ version: 1, tabs: {} })).toBeNull()
    expect(parseTabSession({ version: 2, tabs: [] })).toBeNull()
  })
})

describe('resolveTabSession', () => {
  it('usa a coleção atual para aba salva limpa e como base da aba editada', () => {
    const current = content({ query: 'query { current }' })
    const edited = content({ query: 'query { edited }' })
    const session: TabSession = {
      activeTabId: 'edited',
      tabs: [
        { id: 'clean', requestId: 'request-1', name: 'Nome antigo', draft: null },
        { id: 'edited', requestId: 'request-1', name: 'Nome antigo', draft: edited },
      ],
    }

    expect(resolveTabSession(session, collectionsWith(current))).toEqual([
      { id: 'clean', requestId: 'request-1', name: 'Ping atual', content: current, savedContent: current, fixed: false },
      { id: 'edited', requestId: 'request-1', name: 'Ping atual', content: edited, savedContent: current, fixed: false },
    ])
  })

  it('recupera edição de requisição removida como rascunho e descarta aba limpa removida', () => {
    const edited = content({ query: 'query { edited }' })
    const session: TabSession = {
      activeTabId: 'edited',
      tabs: [
        { id: 'clean', requestId: 'removed-clean', name: 'Limpa', draft: null },
        { id: 'edited', requestId: 'removed-edited', name: 'Recuperada', draft: edited },
      ],
    }

    expect(resolveTabSession(session, [])).toEqual([
      { id: 'edited', requestId: null, name: 'Recuperada', content: edited, savedContent: edited, fixed: false },
    ])
  })
})

describe('sessionFromLegacy', () => {
  it('migra ids na mesma ordem e aponta a aba ativa para o novo id', () => {
    const migrated = sessionFromLegacy({
      openRequestIds: ['request-1', 'request-2'],
      activeRequestId: 'request-2',
    })

    expect(migrated.tabs.map((entry) => entry.requestId)).toEqual(['request-1', 'request-2'])
    expect(migrated.tabs.every((entry) => entry.draft === null)).toBe(true)
    expect(migrated.activeTabId).toBe(migrated.tabs[1]?.id)
  })
})

describe('abas fixadas na sessão', () => {
  it('grava e restaura o estado fixado, omitindo-o nas demais', () => {
    const fixed = tab({ id: 'fixed', requestId: 'request-1', fixed: true })
    const loose = tab({ id: 'loose', requestId: 'request-2' })

    const snapshot = snapshotTabSession([fixed, loose], null, contentOfTab)

    expect(snapshot.tabs).toEqual([
      { id: 'fixed', requestId: 'request-1', name: 'Ping', draft: null, fixed: true },
      { id: 'loose', requestId: 'request-2', name: 'Ping', draft: null },
    ])
    expect(parseTabSession(snapshot)?.tabs.map((entry) => entry.fixed)).toEqual([true, undefined])
  })
})

describe('parseTabSession with gRPC drafts', () => {
  it('restores a gRPC draft and drops one with a malformed call', () => {
    const grpc = {
      service: 'test.Greeter',
      method: 'SayHello',
      schemaSource: { type: 'protoFiles', files: ['protos/a.proto'], importPaths: [] },
      deadlineMs: 2000,
      message: '{"name": "ana"}',
    }
    const parsed = parseTabSession({
      version: 1,
      activeTabId: 'ok',
      tabs: [
        { id: 'ok', requestId: null, name: 'Hello', draft: { protocol: 'grpc', endpointUrl: 'localhost:50051', grpc } },
        { id: 'bad', requestId: null, name: 'Bad', draft: { protocol: 'grpc', grpc: { ...grpc, schemaSource: { type: 'ftp' } } } },
      ],
    })

    expect(parsed?.tabs).toHaveLength(1)
    expect(parsed?.tabs[0]?.draft).toEqual({ ...emptyRequestContent('grpc'), endpointUrl: 'localhost:50051', grpc })
  })
})
