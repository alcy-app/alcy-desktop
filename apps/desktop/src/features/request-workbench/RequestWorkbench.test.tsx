import { useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, render as renderUi, fireEvent, hoverTemplateToken, screen, unhoverTemplateToken, waitFor, within } from '../../test-utils'
import { runBeforeExit } from '../../shared/app-lifecycle/before-exit'
import { RequestWorkbench } from './RequestWorkbench'
import type { ExtensionSidebarModule, PseudoTab } from '../../extensions/types'
import { AgentSection } from '../settings-menu/AgentSection'

// Fixed release notes; real content depends on the current CHANGELOG section.
vi.mock('../updates/release-notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../updates/release-notes')>()),
  CURRENT_RELEASE_NOTES: {
    id: 'release-notes:9.9.9',
    kind: 'update',
    date: '2026-10-01',
    title: { 'pt-BR': 'Novidades da versão 9.9.9', en: 'What is new in 9.9.9' },
    message: { 'pt-BR': '', en: '' },
    details: { 'pt-BR': '## Destaques\n\n- Aba de novidades', en: '## Highlights\n\n- What is new tab' },
  },
}))

const sidebar = () => screen.getByRole('complementary', { name: 'Ambientes' })
const environmentList = () => within(sidebar()).getByRole('list')
const openEnvironmentsTab = () => fireEvent.click(screen.getByRole('tab', { name: 'Ambientes' }))

/** Wait for status in the response summary, since Raw also renders it and stays mounted while hidden. Requery each time: loading and success use different elements. */
const findStatusText = (pattern: RegExp) =>
  screen.findByText(pattern, { selector: '.rw-response-summary, .rw-response-status' })

const testWorkspace = { id: 'workspace-1', name: 'Workspace', rootPath: '/workspace' }
const render = (
  ui: ReactElement = (
    <RequestWorkbench workspace={testWorkspace} onWorkspaceChange={() => {}} onExitToStartScreen={() => {}} />
  ),
) => renderUi(ui)

/** The empty screen appears after collections load and tabs are restored. */
async function createRequestFromEmptyState(protocol: 'GraphQL' | 'REST' = 'REST') {
  fireEvent.click(await screen.findByRole('button', { name: `Nova requisição ${protocol}` }))
}

/** The tab bar plus opens the protocol picker and creates a standalone draft. */
function createRequestFromTabsBar(protocol: 'GraphQL' | 'REST' | 'gRPC' = 'REST') {
  fireEvent.click(screen.getByRole('button', { name: 'Nova aba' }))
  fireEvent.click(screen.getByRole('option', { name: protocol === 'REST' ? 'HTTP' : protocol }))
}

/** Dragging uses pointer events. Mock elementFromPoint and dispatch pointerdown/move/up because jsdom has no native layout or HTML5 dragging. */
/** Mock the target rectangle to select the intended drop half; jsdom otherwise returns zero dimensions and always chooses after. */
function dragOnto(source: Element, target: Element, edge: 'before' | 'after' = 'before') {
  const original = document.elementFromPoint
  document.elementFromPoint = () => target as Element
  const originalRect = target.getBoundingClientRect
  target.getBoundingClientRect = () =>
    ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => {} }) as DOMRect
  const offset = edge === 'before' ? 10 : 90
  fireEvent.pointerDown(source, { button: 0, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(window, { clientX: offset, clientY: offset })
  fireEvent.pointerUp(window)
  document.elementFromPoint = original
  target.getBoundingClientRect = originalRect
}

/** CodeMirror uses contentEditable rather than a textarea. Select all through its real Mod-a keymap, then paste clipboardData. fireEvent wraps document updates in React act before assertions read dependent UI state. */
function replaceEditorContent(labelText: string, text: string) {
  const editor = screen.getByLabelText(labelText)
  editor.focus()
  fireEvent.keyDown(editor, { key: 'a', code: 'KeyA', ctrlKey: true })
  const clipboardData = {
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    types: ['text/plain'],
  }
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  fireEvent(editor, event)
}

/** Dispatch paste with text; jsdom does not insert it itself. */
function pasteText(element: HTMLElement, text: string) {
  const clipboardData = { getData: (type: string) => (type === 'text/plain' ? text : ''), types: ['text/plain'] }
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  fireEvent(element, event)
  return event
}

/** Read rendered CodeMirror lines by accessible label; it has no textarea value. */
function editorText(labelText: string): string {
  const editor = screen.getByLabelText(labelText)
  return Array.from(editor.querySelectorAll('.cm-line'))
    .map((line) => line.textContent ?? '')
    .join('\n')
}

function pasteIntoBodyEditor(text: string) {
  replaceEditorContent('Corpo da requisição', text)
}

function bodyEditorText(): string {
  return editorText('Corpo da requisição')
}

function pasteIntoQueryEditor(text: string) {
  replaceEditorContent('Query GraphQL', text)
}

function queryEditorText(): string {
  return editorText('Query GraphQL')
}

const executeGraphqlRequest = vi.fn()
const executeRestRequest = vi.fn()
const executeGrpcRequest = vi.fn()
const executeWebSocketRequest = vi.fn()
const sendWebSocketMessage = vi.fn()
const closeWebSocket = vi.fn()
const loadGrpcSchema = vi.fn()
const cancelGraphqlRequest = vi.fn()
const listEnvironments = vi.fn()
const saveEnvironments = vi.fn()
const listCollections = vi.fn()
const saveCollections = vi.fn()
const exportCollections = vi.fn()
const importCollections = vi.fn()
const importCollectionsFromText = vi.fn()
const importCollectionsFromUrl = vi.fn()
const preparedImportValues = new Map<string, unknown>()
let preparedImportSequence = 0

type PreparedTestValue = {
  collections: Array<{ name?: string; requests?: unknown[] }>
  environments?: unknown[]
  scriptCount?: number
  warnings?: unknown[]
}

async function preparedResult(result: { ok: true; value: PreparedTestValue } | { ok: false; error: unknown }) {
  if (!result.ok) return { ok: false, error: result.error }
  const id = `prepared-${++preparedImportSequence}`
  preparedImportValues.set(id, result.value)
  const collections = result.value.collections ?? []
  return {
    ok: true,
    value: {
      id,
      format: 'alcy',
      title: collections[0]?.name ?? 'Importação',
      collectionCount: collections.length,
      folderCount: 0,
      requestCount: collections.reduce((count, collection) => count + (collection.requests?.length ?? 0), 0),
      environmentCount: result.value.environments?.length ?? 0,
      supportsDocumentation: false,
      scriptCount: result.value.scriptCount ?? 0,
      warningCount: result.value.warnings?.length ?? 0,
      variables: [],
      environmentNames: [],
      collectionNames: collections.map((collection) => collection.name),
    },
  }
}
const pickExportFile = vi.fn()
const exportHar = vi.fn()
const pickResponseFile = vi.fn()
const saveResponseBody = vi.fn()
const pickImportFiles = vi.fn()
const pickImportFolder = vi.fn()
const expandImportPaths = vi.fn()
const loadSchema = vi.fn()
const getRequestDocs = vi.fn()
const releaseResponseBody = vi.fn()
const listHistory = vi.fn()
const getHistoryEntry = vi.fn()
const getFlowRunHistory = vi.fn()
const loadTabSession = vi.fn()
const saveTabSession = vi.fn()
const getProxySettings = vi.fn()
const onFileDrop = vi.fn()
let persistedTabSession: unknown = null

const featureFlags = vi.hoisted(() => ({ updates: false, valueMonitors: true, localGit: false, notifications: true, webclientExport: true, loadTesting: false, agent: false }))
vi.mock('../../shared/feature-flags', () => ({ FEATURE_FLAGS: featureFlags }))

// Starts empty, like the public build; the extension tests fill it in.
const extensionState = vi.hoisted(() => ({
  sidebarModules: [] as ExtensionSidebarModule[],
  readTabs: null as null | (() => PseudoTab[]),
}))
vi.mock('../../extensions/registry', () => ({
  APP_EXTENSIONS: [],
  EXTENSION_SIDEBAR_MODULES: extensionState.sidebarModules,
  useExtensionWorkbenchTabs: () => (extensionState.readTabs ? extensionState.readTabs() : []),
}))

// Count sidebar renders through the real memo shallow comparison to detect recreated workbench props.
const sidebarRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('./components/WorkbenchSidebar', async (importOriginal) => {
  const original = await importOriginal<typeof import('./components/WorkbenchSidebar')>()
  const { createElement, memo } = await import('react')
  type Props = Parameters<typeof original.WorkbenchSidebar>[0]
  const CountedSidebar = memo(function CountedSidebar(props: Props) {
    sidebarRenders.count += 1
    return createElement(original.WorkbenchSidebar, props)
  })
  return { ...original, WorkbenchSidebar: CountedSidebar }
})

const getWorkspaceLink = vi.fn()
// The Settings menu mounts the Git author section while the git flag is on.
vi.mock('../../bindings/local-git', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getGitIdentity: () => Promise.resolve({
    ok: true,
    value: { system: { name: null, email: null }, overrides: { name: null, email: null }, effective: null },
  }),
}))
vi.mock('../../bindings/get-workspace-link', () => ({
  getWorkspaceLink: (...args: unknown[]) => getWorkspaceLink(...args),
}))

const listValueMonitors = vi.fn()
vi.mock('../../bindings/list-value-monitors', () => ({
  listValueMonitors: (...args: unknown[]) => listValueMonitors(...args),
}))
vi.mock('../../bindings/save-value-monitors', () => ({
  saveValueMonitors: () => Promise.resolve({ ok: true, value: null }),
}))

vi.mock('../../bindings/get-proxy-settings', () => ({
  getProxySettings: (...args: unknown[]) => getProxySettings(...args),
}))
vi.mock('../../bindings/get-general-settings', () => ({
  getGeneralSettings: () => Promise.resolve({ ok: true, value: { requestTimeoutSeconds: 60, responseSizeLimitMb: 50, historyRetentionDays: 7, saveHistoryResponses: false } }),
}))

vi.mock('../../bindings/execute-graphql-request', () => ({
  executeGraphqlRequest: (...args: unknown[]) => executeGraphqlRequest(...args),
}))

vi.mock('../../bindings/execute-rest-request', () => ({
  executeRestRequest: (...args: unknown[]) => executeRestRequest(...args),
}))

vi.mock('../../bindings/execute-grpc-request', () => ({
  executeGrpcRequest: (...args: unknown[]) => executeGrpcRequest(...args),
}))

vi.mock('../../bindings/execute-websocket-request', () => ({
  executeWebSocketRequest: (...args: unknown[]) => executeWebSocketRequest(...args),
  sendWebSocketMessage: (...args: unknown[]) => sendWebSocketMessage(...args),
  closeWebSocket: (...args: unknown[]) => closeWebSocket(...args),
}))

vi.mock('../../bindings/load-grpc-schema', () => ({
  loadGrpcSchema: (...args: unknown[]) => loadGrpcSchema(...args),
}))

vi.mock('../../bindings/cancel-graphql-request', () => ({
  cancelGraphqlRequest: (...args: unknown[]) => cancelGraphqlRequest(...args),
}))

vi.mock('../../bindings/list-environments', () => ({
  listEnvironments: (...args: unknown[]) => listEnvironments(...args),
}))

vi.mock('../../bindings/save-environments', () => ({
  saveEnvironments: (...args: unknown[]) => saveEnvironments(...args),
}))

vi.mock('../../bindings/list-collections', () => ({
  listCollections: (...args: unknown[]) => listCollections(...args),
}))

vi.mock('../../bindings/save-collections', () => ({
  saveCollections: (...args: unknown[]) => saveCollections(...args),
}))

vi.mock('../../bindings/export-collections', () => ({
  exportCollections: (...args: unknown[]) => exportCollections(...args),
}))

vi.mock('../../bindings/import-collections', () => ({
  importCollections: (...args: unknown[]) => importCollections(...args),
}))

vi.mock('../../bindings/import-collections-from-text', () => ({
  importCollectionsFromText: (...args: unknown[]) => importCollectionsFromText(...args),
}))

vi.mock('../../bindings/import-collections-from-url', () => ({
  importCollectionsFromUrl: (...args: unknown[]) => importCollectionsFromUrl(...args),
}))

vi.mock('../../bindings/prepared-import', () => ({
  prepareImportFromPath: async (...args: unknown[]) => preparedResult(await importCollections(...args)),
  prepareImportFromText: async (...args: unknown[]) => preparedResult(await importCollectionsFromText(...args)),
  prepareImportFromUrl: async (...args: unknown[]) => preparedResult(await importCollectionsFromUrl(...args)),
  commitPreparedImport: async (id: string) => {
    const value = preparedImportValues.get(id)
    return value ? { ok: true, value } : { ok: false, error: { kind: 'invalid', message: 'expirou' } }
  },
  discardPreparedImport: async (id: string) => { preparedImportValues.delete(id) },
}))

vi.mock('../../bindings/on-file-drop', () => ({
  onFileDrop: (...args: unknown[]) => onFileDrop(...args),
}))

vi.mock('../../bindings/export-har', () => ({
  exportHar: (...args: unknown[]) => exportHar(...args),
}))

vi.mock('../../bindings/pick-response-file', () => ({
  pickResponseFile: (...args: unknown[]) => pickResponseFile(...args),
}))

vi.mock('../../bindings/save-response-body', () => ({
  saveResponseBody: (...args: unknown[]) => saveResponseBody(...args),
}))

vi.mock('../../bindings/pick-export-file', () => ({
  pickExportFile: (...args: unknown[]) => pickExportFile(...args),
}))

vi.mock('../../bindings/pick-import-file', () => ({
  pickImportFiles: (...args: unknown[]) => pickImportFiles(...args),
  pickImportFolder: (...args: unknown[]) => pickImportFolder(...args),
}))

vi.mock('../../bindings/expand-import-paths', () => ({
  expandImportPaths: (...args: unknown[]) => expandImportPaths(...args),
}))

vi.mock('../../bindings/get-request-docs', () => ({
  getRequestDocs: (...args: unknown[]) => getRequestDocs(...args),
}))

vi.mock('../../bindings/load-schema', () => ({
  loadSchema: (...args: unknown[]) => loadSchema(...args),
}))

vi.mock('../../bindings/release-response-body', () => ({
  releaseResponseBody: (...args: unknown[]) => releaseResponseBody(...args),
}))

vi.mock('../../bindings/list-history', () => ({
  listHistory: (...args: unknown[]) => listHistory(...args),
}))

vi.mock('../../bindings/get-history-entry', () => ({
  getHistoryEntry: (...args: unknown[]) => getHistoryEntry(...args),
}))

vi.mock('../../bindings/get-flow-run-history', () => ({
  getFlowRunHistory: (...args: unknown[]) => getFlowRunHistory(...args),
}))

vi.mock('../../bindings/load-tab-session', () => ({
  loadTabSession: (...args: unknown[]) => loadTabSession(...args),
}))

vi.mock('../../bindings/save-tab-session', () => ({
  saveTabSession: (...args: unknown[]) => saveTabSession(...args),
}))

const defaultSnapshot = {
  environments: [
    { id: 'env-dev', name: 'Development', variables: [] },
    { id: 'env-prod', name: 'Production', variables: [] },
  ],
  activeEnvironmentId: 'env-dev',
}

beforeEach(() => {
  featureFlags.valueMonitors = true
  featureFlags.localGit = true
  featureFlags.notifications = true
  featureFlags.webclientExport = true
  getWorkspaceLink.mockReset()
  getWorkspaceLink.mockResolvedValue({ ok: true, value: null })
  listValueMonitors.mockReset()
  listValueMonitors.mockResolvedValue({
    ok: true,
    value: [{ id: 'm1', name: 'Nome curto', enabled: true, fields: ['nome'], rules: [] }],
  })
  getProxySettings.mockReset()
  getProxySettings.mockResolvedValue({ ok: true, value: { mode: 'disabled', pacUrl: null, error: null } })
  executeGraphqlRequest.mockReset()
  executeRestRequest.mockReset()
  executeGrpcRequest.mockReset()
  executeWebSocketRequest.mockReset()
  sendWebSocketMessage.mockReset()
  closeWebSocket.mockReset()
  loadGrpcSchema.mockReset()
  cancelGraphqlRequest.mockReset()
  listEnvironments.mockReset()
  saveEnvironments.mockReset()
  listCollections.mockReset()
  saveCollections.mockReset()
  exportCollections.mockReset()
  importCollections.mockReset()
  importCollectionsFromText.mockReset()
  importCollectionsFromUrl.mockReset()
  preparedImportValues.clear()
  preparedImportSequence = 0
  pickExportFile.mockReset()
  exportHar.mockReset()
  pickResponseFile.mockReset()
  saveResponseBody.mockReset()
  pickImportFiles.mockReset()
  pickImportFolder.mockReset()
  expandImportPaths.mockReset()
  loadSchema.mockReset()
  getRequestDocs.mockReset()
  releaseResponseBody.mockReset()
  listHistory.mockReset()
  getHistoryEntry.mockReset()
  getFlowRunHistory.mockReset()
  loadTabSession.mockReset()
  saveTabSession.mockReset()
  persistedTabSession = null
  onFileDrop.mockReset()
  listEnvironments.mockResolvedValue({ ok: true, value: defaultSnapshot })
  saveEnvironments.mockResolvedValue({ ok: true })
  listCollections.mockResolvedValue({ ok: true, value: [] })
  listHistory.mockResolvedValue({ ok: true, value: [] })
  // Saved GraphQL tabs automatically load schemas. Most tests use a neutral response; schema tests override it.
  loadSchema.mockResolvedValue({
    ok: true,
    value: { queryType: null, mutationType: null, subscriptionType: null, types: [], directives: [] },
  })
  saveCollections.mockResolvedValue({ ok: true })
  loadTabSession.mockImplementation(async () => ({ ok: true, value: persistedTabSession }))
  saveTabSession.mockImplementation(async (_rootPath: string, session: unknown) => {
    persistedTabSession = session
    return { ok: true, value: null }
  })
  onFileDrop.mockResolvedValue(() => {})
  exportCollections.mockResolvedValue({ ok: true })
  importCollections.mockResolvedValue({ ok: true, value: { collections: [], environments: [] } })
  importCollectionsFromText.mockResolvedValue({ ok: true, value: { collections: [], environments: [] } })
  importCollectionsFromUrl.mockResolvedValue({ ok: true, value: { collections: [], environments: [] } })
  pickExportFile.mockResolvedValue(null)
  pickImportFiles.mockResolvedValue([])
  pickImportFolder.mockResolvedValue(null)
  expandImportPaths.mockImplementation(async (paths: string[]) => ({ ok: true, value: paths }))
})

describe('RequestWorkbench', () => {
  it('mostra a tela de descanso na primeira vez que o workspace é aberto, sem nenhuma aba', async () => {
    render()

    expect(screen.getByRole('heading', { name: 'Alcy' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Nova requisição GraphQL' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Query' })).not.toBeInTheDocument()

    expect(await screen.findByLabelText('Ambiente')).toHaveValue('env-dev')
    openEnvironmentsTab()
    expect(within(environmentList()).getByText('Development')).toBeInTheDocument()
    expect(within(environmentList()).getByText('ativo')).toBeInTheDocument()
  })

  it('permite ocultar e restaurar módulos pelo menu de contexto da barra lateral', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Componentes' }))
    expect(screen.getByRole('menuitem', { name: 'Ocultar Componentes' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Componentes' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Ocultar Componentes' }))
    expect(screen.queryByRole('tab', { name: 'Componentes' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Ambientes', selected: true })).toBeInTheDocument()

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Ambientes' }))
    const components = screen.getByRole('menuitemcheckbox', { name: 'Componentes' })
    expect(components).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(components)
    expect(screen.getByRole('tab', { name: 'Componentes' })).toBeInTheDocument()
  })

  it('abre o menu de módulos no espaço vazio da barra lateral', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Navegação principal' }))

    expect(screen.queryByRole('menuitem', { name: 'Ocultar Componentes' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Componentes' })).toHaveAttribute('aria-checked', 'true')
  })

  it('oferece os dois protocolos e cria uma aba REST com URL vazia em um clique', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    expect(await screen.findByRole('button', { name: 'Nova requisição GraphQL' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nova requisição REST' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Nova requisição REST' }))

    expect(screen.queryByRole('button', { name: 'Nova requisição REST' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Endpoint')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toHaveValue('get')
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Params', selected: true })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Query' })).not.toBeInTheDocument()
    expect(screen.getByText('Nenhuma requisição enviada')).toBeInTheDocument()
  })

  it('cria uma aba GraphQL com URL vazia pelo menu da tela de descanso', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    await createRequestFromEmptyState('GraphQL')

    expect(screen.getByLabelText('Endpoint')).toHaveValue('')
    expect(screen.getByRole('tab', { name: 'Query', selected: true })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Método HTTP' })).not.toBeInTheDocument()
  })

  describe('requisições gRPC', () => {
    it('cria uma requisição gRPC, escolhe o método, gera a mensagem e mostra o status da resposta', async () => {
      const template = '{\n  "name": ""\n}'
      loadGrpcSchema.mockResolvedValue({
        ok: true,
        value: {
          services: [
            {
              name: 'test.Greeter',
              methods: [
                {
                  name: 'SayHello',
                  kind: 'unary',
                  inputType: 'test.HelloRequest',
                  outputType: 'test.HelloReply',
                  inputTemplate: template,
                  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              ],
            },
          ],
        },
      })
      executeGrpcRequest.mockResolvedValue({
        ok: true,
        value: {
          status: { code: 0, codeName: 'OK', message: '' },
          durationMs: 12,
          sizeBytes: 9,
          messageCount: 1,
          body: { kind: 'inline', body: '{"message": "hi"}' },
          headers: [{ name: 'x-server', value: 'test' }],
          trailers: [],
          scriptLogs: ['grpc script ran'],
          testResults: [{ name: 'RPC status', passed: true, message: null }],
        },
      })
      render()
      await screen.findByLabelText('Ambiente')

      fireEvent.click(await screen.findByRole('button', { name: 'Nova requisição gRPC' }))
      expect(screen.getByRole('tab', { name: 'Message' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: 'Metadata' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Scripts' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Compartilhar requisição' }))
      expect(screen.getByRole('menuitem', { name: 'Como código' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Como imagem' })).toBeInTheDocument()
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Como código' }), { key: 'Escape' })

      fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'localhost:50051' } })
      fireEvent.click(screen.getByRole('button', { name: 'Método gRPC' }))
      await waitFor(() => expect(loadGrpcSchema).toHaveBeenCalledTimes(1))
      expect(loadGrpcSchema.mock.calls[0][0]).toMatchObject({ endpoint: 'localhost:50051', schemaSource: { type: 'reflection' } })
      fireEvent.click(await screen.findByRole('option', { name: /SayHello/ }))
      expect(screen.getByText('test.HelloRequest')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Gerar exemplo' }))

      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

      await waitFor(() => expect(executeGrpcRequest).toHaveBeenCalledTimes(1))
      expect(executeGrpcRequest.mock.calls[0][0]).toMatchObject({
        endpoint: 'localhost:50051',
        service: 'test.Greeter',
        method: 'SayHello',
        message: template,
        deadlineMs: null,
      })
      expect(executeRestRequest).not.toHaveBeenCalled()
      expect(await screen.findByText('gRPC OK')).toBeInTheDocument()
      expect(screen.getByText('1 mensagem(ns)')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: /Tests/ }))
      expect(screen.getByText('RPC status')).toBeInTheDocument()
      // The request's metadata tab and the response's (headers and trailers).
      expect(screen.getAllByRole('tab', { name: 'Metadata' })).toHaveLength(2)
    })
  })

  describe('requisições WebSocket', () => {
    it('conecta, mostra as mensagens, envia pelo composer e desconecta', async () => {
      let finish: (value: unknown) => void = () => {}
      executeWebSocketRequest.mockImplementation((_input: unknown, onEvent: (event: unknown) => void) => {
        onEvent({ type: 'opened', status: 101, headers: [{ name: 'upgrade', value: 'websocket' }], subprotocol: null, elapsedMs: 3 })
        onEvent({ type: 'message', direction: 'received', index: 0, format: 'text', data: 'welcome aboard', truncated: false, sizeBytes: 14, elapsedMs: 5 })
        return new Promise((resolve) => { finish = resolve })
      })
      sendWebSocketMessage.mockResolvedValue({ ok: true, value: null })
      closeWebSocket.mockImplementation(async () => {
        finish({
          ok: true,
          value: {
            statusCode: 101, durationMs: 40, sizeBytes: 14, body: { kind: 'inline', body: 'welcome aboard' },
            headers: [{ name: 'upgrade', value: 'websocket' }], requestHeaders: [], cookies: [],
            connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
            waitingMs: 3, close: { code: 1000, reason: '', closedBy: 'client' }, subprotocol: null,
            sentCount: 1, receivedCount: 1, environmentChanges: [], scopedChanges: [], scriptLogs: [], scriptError: null, testResults: [],
          },
        })
        return { ok: true, value: null }
      })
      render()
      await screen.findByLabelText('Ambiente')

      fireEvent.click(await screen.findByRole('button', { name: 'Nova requisição WebSocket' }))
      expect(screen.getByRole('tab', { name: 'Message' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled()

      fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'wss://chat.test/socket' } })
      fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))

      await waitFor(() => expect(executeWebSocketRequest).toHaveBeenCalledTimes(1))
      expect(executeWebSocketRequest.mock.calls[0][0]).toMatchObject({
        endpointUrl: 'wss://chat.test/socket',
        websocket: { subprotocols: [], messageFormat: 'text' },
      })
      expect(executeRestRequest).not.toHaveBeenCalled()
      expect(await screen.findByText('welcome aboard')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }))
      await waitFor(() => expect(sendWebSocketMessage).toHaveBeenCalledTimes(1))
      expect(sendWebSocketMessage.mock.calls[0][2]).toBe('text')

      fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }))
      await waitFor(() => expect(closeWebSocket).toHaveBeenCalledTimes(1))
      expect(await screen.findByText(/Encerrada pelo Alcy · 1000/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Conectar' })).toBeInTheDocument()
    })
  })

  describe('cURL colado na barra de endpoint', () => {
    const curlRequest = (overrides: Record<string, unknown> = {}) => ({
      id: 'curl-1',
      name: 'POST /users',
      protocol: 'rest',
      endpoint: 'https://api.test/users?expand=true',
      method: 'post',
      body: '{"name":"Ana"}',
      restBody: { type: 'raw', rawLanguage: 'json', content: '{"name":"Ana"}' },
      variables: '',
      headers: [{ name: 'X-Token', value: 'abc', enabled: true }],
      authentication: { type: 'none' },
      preRequestScript: '',
      postResponseScript: '',
      ...overrides,
    })
    const importedCurl = (request: Record<string, unknown>) => ({
      ok: true,
      value: { collections: [{ id: 'c', name: 'api.test', folders: [], requests: [request] }], environments: [] },
    })

    it.each(['REST', 'gRPC'] as const)('imports grpcurl into a %s tab and uses the imported method when sending', async (protocol) => {
      importCollectionsFromText.mockResolvedValue(importedCurl(curlRequest({
        protocol: 'grpc', endpoint: 'grpc://grpcb.in:9000', body: '{"greeting":"Ana"}',
        grpc: { service: 'hello.HelloService', method: 'SayHello', schemaSource: { type: 'reflection' }, deadlineMs: 2500 },
      })))
      executeGrpcRequest.mockResolvedValue({ ok: false, error: { kind: 'cancelled' } })
      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar(protocol)
      const endpoint = screen.getByLabelText('Endpoint') as HTMLInputElement
      fireEvent.change(endpoint, { target: { value: 'https://old.test' } })
      endpoint.setSelectionRange(0, endpoint.value.length)
      const command = `grpcurl -plaintext -max-time 2.5 -H 'X-Token: abc' -d '{"greeting":"Ana"}' grpcb.in:9000 hello.HelloService/SayHello`
      expect(pasteText(endpoint, command).defaultPrevented).toBe(true)
      await waitFor(() => expect(endpoint).toHaveValue('grpc://grpcb.in:9000'))
      expect(screen.getByRole('tab', { name: 'Message', selected: true })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Método gRPC' })).toHaveTextContent('SayHello')
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
      await waitFor(() => expect(executeGrpcRequest).toHaveBeenCalledTimes(1))
      expect(executeGrpcRequest.mock.calls[0][0]).toMatchObject({
        endpoint: 'grpc://grpcb.in:9000', service: 'hello.HelloService', method: 'SayHello',
        message: '{"greeting":"Ana"}', deadlineMs: 2500,
        schemaSource: { type: 'reflection' }, headers: [{ name: 'X-Token', value: 'abc', enabled: true }],
      })
      expect(executeRestRequest).not.toHaveBeenCalled()
    })

    it('preenche a aba com o comando colado na URL vazia, mostrando o carregamento', async () => {
      importCollectionsFromText.mockResolvedValue(importedCurl(curlRequest()))
      const command = `curl -X POST 'https://api.test/users?expand=true' -H 'X-Token: abc' -d '{"name":"Ana"}'`

      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('REST')

      const event = pasteText(screen.getByLabelText('Endpoint'), command)

      expect(event.defaultPrevented).toBe(true)
      expect(screen.getByRole('status')).toHaveTextContent('Importando comando…')
      expect(screen.getByLabelText('Endpoint')).toHaveAttribute('readonly')
      expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Mais opções de envio' })).toBeDisabled()
      expect(importCollectionsFromText).toHaveBeenCalledWith(command, '/workspace')

      await waitFor(() => expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.test/users?expand=true'))
      expect(screen.queryByText('Importando comando…')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Endpoint')).not.toHaveAttribute('readonly')
      expect(screen.getByRole('button', { name: 'Mais opções de envio' })).toBeEnabled()
      expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toHaveValue('post')
      expect(screen.getByDisplayValue('expand')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
      expect(screen.getByDisplayValue('X-Token')).toBeInTheDocument()
      expect(screen.getByDisplayValue('abc')).toBeInTheDocument()
    })

    it('troca a aba para GraphQL quando o comando traz uma query', async () => {
      importCollectionsFromText.mockResolvedValue(
        importedCurl(
          curlRequest({
            protocol: 'graphql',
            endpoint: 'https://api.test/graphql',
            body: 'query { me { id } }',
            restBody: null,
            variables: '{}',
            headers: [],
          }),
        ),
      )

      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('REST')

      pasteText(screen.getByLabelText('Endpoint'), `curl https://api.test/graphql -d '{"query":"query { me { id } }"}'`)

      await waitFor(() => expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.test/graphql'))
      expect(screen.getByRole('tab', { name: 'Query', selected: true })).toBeInTheDocument()
      expect(screen.queryByRole('combobox', { name: 'Método HTTP' })).not.toBeInTheDocument()
    })

    it('substitui a URL inteira selecionada pelo comando colado', async () => {
      importCollectionsFromText.mockResolvedValue(importedCurl(curlRequest()))

      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('REST')

      const endpoint = screen.getByLabelText('Endpoint') as HTMLInputElement
      fireEvent.change(endpoint, { target: { value: 'https://old.test/items' } })
      endpoint.setSelectionRange(0, endpoint.value.length)

      expect(pasteText(endpoint, 'curl -X POST https://api.test/users').defaultPrevented).toBe(true)

      await waitFor(() => expect(endpoint).toHaveValue('https://api.test/users?expand=true'))
      expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toHaveValue('post')
    })

    it('cola normalmente quando a URL tem conteúdo não selecionado por inteiro ou o texto não é um comando', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('REST')

      const endpoint = screen.getByLabelText('Endpoint') as HTMLInputElement
      expect(pasteText(endpoint, 'https://api.test/users').defaultPrevented).toBe(false)

      fireEvent.change(endpoint, { target: { value: 'https://api.test' } })
      endpoint.setSelectionRange(8, 8)
      expect(pasteText(endpoint, 'curl https://api.test/users').defaultPrevented).toBe(false)

      endpoint.setSelectionRange(0, 8)
      expect(pasteText(endpoint, 'curl https://api.test/users').defaultPrevented).toBe(false)

      endpoint.setSelectionRange(0, endpoint.value.length)
      expect(pasteText(endpoint, 'https://other.test').defaultPrevented).toBe(false)

      expect(importCollectionsFromText).not.toHaveBeenCalled()
      expect(screen.queryByText('Importando comando…')).not.toBeInTheDocument()
    })

    it('avisa o erro do comando e mantém a URL vazia', async () => {
      importCollectionsFromText.mockResolvedValue({ ok: false, error: { kind: 'invalid', message: 'aspas não fechadas' } })

      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('REST')

      pasteText(screen.getByLabelText('Endpoint'), "curl 'https://api.test")

      expect(await screen.findByText('Não foi possível importar o comando: aspas não fechadas')).toBeInTheDocument()
      expect(screen.getByLabelText('Endpoint')).toHaveValue('')
      expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toHaveValue('get')
    })
  })

  it('troca de aba ao clicar', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    expect(screen.queryByRole('button', { name: 'Adicionar header' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))

    expect(screen.getByRole('tab', { name: 'Headers', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adicionar header' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Query GraphQL')).not.toBeInTheDocument()
  })

  it('navega entre abas com as setas do teclado', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    const queryTab = screen.getByRole('tab', { name: 'Query' })
    queryTab.focus()

    fireEvent.keyDown(queryTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Variables', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Variables' })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Variables' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Query', selected: true })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Query' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Schema', selected: true })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Schema' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Docs', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Docs' })).toHaveFocus()
  })

  it('envia a requisição real e transita de carregando para sucesso', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body: { kind: 'inline', body: '{"data":{}}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeEnabled()
    expect(screen.getByText('Enviando requisição…')).toBeInTheDocument()

    expect(await findStatusText(/200/)).toBeInTheDocument()
    expect(screen.getByText(/GraphQL: Success/)).toBeInTheDocument()
    expect(document.querySelector('.rw-code-block')).toHaveTextContent('"data": {}')
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled()

    expect(executeGraphqlRequest).toHaveBeenCalledTimes(1)
    const call = executeGraphqlRequest.mock.calls[0][0]
    expect(call.authentication).toEqual({ type: 'inherit' })
    expect(call.environmentVariables).toEqual([])
    expect(typeof call.executionId).toBe('string')
    expect(call.executionId.length).toBeGreaterThan(0)
  })

  it('mostra a aba Scripts logo após Body em REST e grava no ambiente as variáveis definidas por scripts', async () => {
    executeRestRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 5,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [{ name: 'token', value: 'abc' }],
        scriptLogs: [],
        scriptError: null,
        headers: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')

    const tabNames = within(screen.getByRole('tablist', { name: 'Seções da requisição' }))
      .getAllByRole('tab')
      .map((tab) => tab.textContent)
    expect(tabNames.indexOf('Scripts')).toBe(tabNames.indexOf('Body') + 1)

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)
    expect(executeRestRequest.mock.calls[0][0].preRequestScript).toBe('')

    openEnvironmentsTab()
    expect(screen.getByDisplayValue('token')).toBeInTheDocument()
    expect(screen.getByDisplayValue('abc')).toBeInTheDocument()
  })

  it('abre uma aba REST com seletor de método, envia via execute_rest_request e não mostra a aba Errors', async () => {
    executeRestRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 201,
        durationMs: 40,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')

    expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Body' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Query' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Método HTTP' }), { target: { value: 'post' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    expect(await findStatusText(/201/)).toBeInTheDocument()
    expect(executeGraphqlRequest).not.toHaveBeenCalled()
    expect(executeRestRequest).toHaveBeenCalledTimes(1)
    expect(executeRestRequest.mock.calls[0][0].method).toBe('post')
    expect(executeRestRequest.mock.calls[0][0].tabId).toEqual(expect.any(String))
    expect(screen.queryByRole('tab', { name: 'Errors' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Histórico de envios desta requisição' })).toBeInTheDocument()
  })

  it('deriva parâmetros de rota da URL, mantém o token visível e envia o valor separado', async () => {
    executeRestRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 10,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')

    const endpoint = screen.getByLabelText('Endpoint')
    fireEvent.change(endpoint, {
      target: { value: 'https://api.test/users/:userId?expand=true' },
    })

    expect(screen.getByRole('heading', { name: 'Path Variables' })).toBeInTheDocument()
    const routeParamsTable = screen.getByRole('table', { name: 'Variáveis de caminho da requisição' })
    expect(within(routeParamsTable).getByDisplayValue('userId')).toBeInTheDocument()
    expect(within(routeParamsTable).queryByText(':userId')).not.toBeInTheDocument()
    expect(document.querySelector('.route-param-token')).toHaveTextContent(':userId')
    fireEvent.change(screen.getByLabelText('Valor da variável de caminho userId'), {
      target: { value: '42' },
    })
    expect(endpoint).toHaveValue('https://api.test/users/:userId?expand=true')

    fireEvent.change(screen.getByLabelText('Nome da variável de caminho userId'), {
      target: { value: 'accountId' },
    })
    expect(endpoint).toHaveValue('https://api.test/users/:accountId?expand=true')
    expect(document.querySelector('.route-param-token')).toHaveTextContent(':accountId')

    hoverTemplateToken(document.querySelector('.route-param-token') as Element)
    await waitFor(() => expect(document.querySelector('.var-tooltip input')).toBeInTheDocument())
    fireEvent.change(document.querySelector('.var-tooltip input') as HTMLInputElement, {
      target: { value: '84' },
    })
    expect(within(routeParamsTable).getByLabelText('Valor da variável de caminho accountId')).toHaveValue('84')
    expect(endpoint).toHaveValue('https://api.test/users/:accountId?expand=true')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(executeRestRequest).toHaveBeenCalledTimes(1))

    expect(executeRestRequest.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        endpointUrl: 'https://api.test/users/:accountId?expand=true',
        routeParams: [{ name: 'accountId', value: '84' }],
      }),
    )

    fireEvent.click(within(routeParamsTable).getByRole('button', { name: 'Remover variável de caminho accountId' }))
    expect(endpoint).toHaveValue('https://api.test/users?expand=true')
    expect(screen.queryByRole('heading', { name: 'Path Variables' })).not.toBeInTheDocument()
  })

  it('troca o tipo de corpo REST, sincroniza o Content-Type e envia o corpo estruturado', async () => {
    executeRestRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 10,
        sizeBytes: 2,
        body: { kind: 'inline', body: '{}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')
    fireEvent.click(screen.getByRole('tab', { name: 'Body' }))

    fireEvent.click(screen.getByRole('radio', { name: 'x-www-form-urlencoded' }))
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar campo' }))
    fireEvent.change(screen.getByLabelText('Nome do campo'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('Valor do campo'), { target: { value: 'ada' } })

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    expect(screen.getByDisplayValue('Content-Type')).toBeInTheDocument()
    expect(screen.getByDisplayValue('application/x-www-form-urlencoded')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(executeRestRequest).toHaveBeenCalledTimes(1))
    const input = executeRestRequest.mock.calls[0][0]
    expect(input.body).toEqual({ type: 'urlencoded', fields: [{ name: 'user', value: 'ada', enabled: true }] })
    expect(input.headers).toContainEqual({ name: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true })
  })

  it('distingue respostas HTTP 4xx e 5xx e formata o tamanho legível', async () => {
    const response = (statusCode: number, sizeBytes: number) => ({
      ok: true,
      value: {
        statusCode,
        durationMs: 12,
        sizeBytes,
        body: { kind: 'inline' as const, body: '{}' },
        bodyEncoding: 'text' as const,
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
      },
    })
    executeRestRequest.mockResolvedValueOnce(response(404, 1_500)).mockResolvedValueOnce(response(500, 2_000_000))

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(await findStatusText(/404/)).toHaveClass('rw-response-status--warning')
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(await findStatusText(/500/)).toHaveClass('rw-response-status--error')
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
  })

  it('permite salvar uma aba REST (Salvar habilitado no menu de contexto, abre a modal de salvar)', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Nova requisição' }))
    expect(screen.getByRole('menuitem', { name: 'Salvar' })).toBeEnabled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Salvar' }))

    expect(screen.getByRole('dialog', { name: 'Salvar requisição' })).toBeInTheDocument()
  })

  it('abre a modal de compartilhar com o código da requisição ativa', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar requisição' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Como código' }))

    const dialog = await screen.findByRole('dialog', { name: 'Compartilhar requisição' })
    expect(within(dialog).getByRole('combobox', { name: 'Linguagem' })).toHaveTextContent('cURL')
    expect(within(dialog).getByLabelText('Código gerado').textContent).toContain('--request POST')
  })

  it('abre a modal de compartilhar como imagem com as opções de campos', async () => {
    // jsdom has no canvas: preview fails, but options remain available.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    onTestFinished(() => getContext.mockRestore())
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar requisição' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Como imagem' }))

    const dialog = await screen.findByRole('dialog', { name: 'Compartilhar como imagem' })
    expect(within(dialog).getByRole('checkbox', { name: 'Método e URL' })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: 'Corpo da resposta' })).toBeDisabled()
    expect(screen.queryByRole('menu', { name: 'Compartilhar requisição' })).not.toBeInTheDocument()
  })

  it('formata o corpo JSON da resposta', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 10,
        sizeBytes: 30,
        body: { kind: 'inline', body: '{"data":{"currentCustomer":{"id":"1","active":true}}}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)

    await waitFor(() => {
      expect(document.querySelector('.rw-code-block')).toHaveTextContent('"currentCustomer": { "id": "1", "active": true }')
    })
  })

  it('mantém o corpo original sem formatar quando a resposta não é JSON válido', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 500,
        durationMs: 5,
        sizeBytes: 20,
        body: { kind: 'inline', body: 'Internal Server Error' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/500/)

    // The body is rendered by the code viewer after the status line, so wait for it too.
    await waitFor(() => expect(document.querySelector('.rw-code-block')).toHaveTextContent('Internal Server Error'))
  })

  it('mostra os headers da resposta na aba Headers', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body: { kind: 'inline', body: '{"data":{}}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        graphqlErrors: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)

    const responsePanel = screen.getByRole('region', { name: 'Resposta da requisição' })
    fireEvent.click(within(responsePanel).getByRole('tab', { name: 'Headers' }))

    expect(within(responsePanel).getByText('Content-Type')).toBeInTheDocument()
    expect(within(responsePanel).getByText('application/json')).toBeInTheDocument()
  })

  it('mostra headers efetivos, cookies, conexão e a visão raw ao expandir uma linha do console', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body: { kind: 'inline', body: '{"data":{}}' },
        bodyEncoding: 'text',
        requestHeaders: [{ name: 'authorization', value: 'Bearer secret-token' }],
        cookies: [
          {
            name: 'session',
            value: 'abc123',
            domain: 'api.example.com',
            path: '/',
            expires: null,
            maxAgeSeconds: null,
            secure: true,
            httpOnly: true,
            sameSite: 'Strict',
          },
        ],
        connection: { remoteAddress: '127.0.0.1:8080', httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 30,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        graphqlErrors: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Abrir console de requisições' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes da requisição' }))
    const detail = screen.getByText('Network').closest('.console-entry-detail-content') as HTMLElement

    expect(within(detail).getByText('authorization')).toBeInTheDocument()
    expect(within(detail).getByText('Bearer secret-token')).toBeInTheDocument()
    expect(within(detail).getByText('session')).toBeInTheDocument()
    expect(within(detail).getByText('abc123')).toBeInTheDocument()
    expect(within(detail).getByText('30 ms')).toBeInTheDocument()
    expect(within(detail).getByText('127.0.0.1:8080')).toBeInTheDocument()
    expect(within(detail).getByText('HTTP/1.1')).toBeInTheDocument()

    fireEvent.click(within(detail).getByRole('button', { name: 'Mostrar raw' }))
    const rawBlocks = detail.querySelector('.console-entry-raw')!.querySelectorAll('.rw-code-block')
    expect(rawBlocks).toHaveLength(2)
    expect(rawBlocks[0]).toHaveTextContent('authorization: Bearer secret-token')
    expect(rawBlocks[1]).toHaveTextContent('HTTP 200')
  })

  it('mostra o console ao lado do gravador HAR, à esquerda, e oculta o proxy quando desativado', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    const recorder = screen.getByRole('button', { name: 'Abrir gravador HAR' })
    const console_ = screen.getByRole('button', { name: 'Abrir console de requisições' })
    expect(recorder.nextElementSibling).toBe(console_)
    expect(screen.queryByRole('button', { name: /Proxy ativo/ })).not.toBeInTheDocument()
  })

  it('abre o painel inferior com todas as abas, na ordem da barra de status', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    fireEvent.click(screen.getByRole('button', { name: 'Abrir console de requisições' }))
    const tools = screen.getByRole('tablist', { name: 'Ferramentas de diagnóstico' })
    expect(within(tools).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Gravador HAR', 'Console'])
    expect(within(tools).getByRole('tab', { name: 'Console' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Abrir gravador HAR' }))
    expect(within(tools).getByRole('tab', { name: 'Gravador HAR' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Abrir gravador HAR' }))
    expect(screen.queryByRole('tablist', { name: 'Ferramentas de diagnóstico' })).not.toBeInTheDocument()
  })

  it('mostra o ícone de proxy na barra de status quando ativo e abre as configurações', async () => {
    getProxySettings.mockResolvedValue({ ok: true, value: { mode: 'pac', pacUrl: 'https://corp/p.pac', error: null } })
    render()

    const proxyButton = await screen.findByRole('button', { name: /Proxy ativo: Script PAC/ })
    fireEvent.click(proxyButton)

    expect(await screen.findByTestId('proxy-settings')).toBeVisible()
    expect(screen.getByDisplayValue('https://corp/p.pac')).toBeInTheDocument()
  })

  it('grava requisições só com o gravador ativo e salva o HAR', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body: { kind: 'inline', body: '{"data":{}}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 10,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [],
      },
    })
    pickExportFile.mockResolvedValue('/tmp/session.har')
    exportHar.mockResolvedValue({ ok: true })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Abrir gravador HAR' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)
    expect(screen.getByRole('button', { name: 'Salvar .har' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Iniciar gravação' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar .har' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Salvar .har' }))
    await waitFor(() => expect(exportHar).toHaveBeenCalledTimes(1))
    expect(pickExportFile).toHaveBeenCalledWith('alcy-sessao', 'har')
    const [path, content] = exportHar.mock.calls[0] as [string, string]
    expect(path).toBe('/tmp/session.har')
    expect(JSON.parse(content).log.entries).toHaveLength(1)
  })

  describe('baixar resposta', () => {
    const successfulSend = (body: unknown, headers = [{ name: 'Content-Type', value: 'application/json' }]) => ({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body,
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 10,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers,
        graphqlErrors: [],
      },
    })

    const chooseDownloadResponse = async () => {
      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('GraphQL')
      const toggle = screen.getByRole('button', { name: 'Mais opções de envio' })
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Baixar resposta' }))
    }

    it('envia e grava o corpo inline no arquivo escolhido', async () => {
      executeGraphqlRequest.mockResolvedValue(successfulSend({ kind: 'inline', body: '{"data":{}}' }))
      pickResponseFile.mockResolvedValue('/tmp/resposta.json')
      saveResponseBody.mockResolvedValue({ ok: true })

      await chooseDownloadResponse()

      expect(await screen.findByText('Resposta salva.')).toBeInTheDocument()
      expect(executeGraphqlRequest).toHaveBeenCalledTimes(1)
      expect(pickResponseFile).toHaveBeenCalledWith(expect.stringMatching(/\.json$/), 'Todos os arquivos')
      expect(saveResponseBody).toHaveBeenCalledWith({
        path: '/tmp/resposta.json',
        encoding: 'text',
        source: { kind: 'inline', body: '{"data":{}}' },
      })
      // The response stays visible as after an ordinary send.
      await findStatusText(/200/)
    })

    it('manda só o handle de um corpo grande retido no backend', async () => {
      executeGraphqlRequest.mockResolvedValue(
        successfulSend({ kind: 'windowed', handle: 'exec-1', totalBytes: 9_000_000, preview: '{"data"', previewNextOffset: 7 }),
      )
      pickResponseFile.mockResolvedValue('/tmp/grande.json')
      saveResponseBody.mockResolvedValue({ ok: true })

      await chooseDownloadResponse()

      await waitFor(() => expect(saveResponseBody).toHaveBeenCalledTimes(1))
      expect(saveResponseBody).toHaveBeenCalledWith({ path: '/tmp/grande.json', encoding: 'text', source: { kind: 'windowed', handle: 'exec-1' } })
    })

    it('não grava nada quando o diálogo é cancelado', async () => {
      executeGraphqlRequest.mockResolvedValue(successfulSend({ kind: 'inline', body: '{}' }))
      pickResponseFile.mockResolvedValue(null)

      await chooseDownloadResponse()

      await waitFor(() => expect(pickResponseFile).toHaveBeenCalledTimes(1))
      expect(saveResponseBody).not.toHaveBeenCalled()
    })

    it('não abre o diálogo quando o envio falha', async () => {
      executeGraphqlRequest.mockResolvedValue({ ok: false, error: { kind: 'timeout' } })

      await chooseDownloadResponse()

      await waitFor(() => expect(executeGraphqlRequest).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument())
      expect(pickResponseFile).not.toHaveBeenCalled()
    })

    it('avisa quando a resposta não está mais disponível no backend', async () => {
      executeGraphqlRequest.mockResolvedValue(successfulSend({ kind: 'inline', body: '{}' }))
      pickResponseFile.mockResolvedValue('/tmp/resposta.json')
      saveResponseBody.mockResolvedValue({ ok: false, error: { kind: 'notFound' } })

      await chooseDownloadResponse()

      expect(await screen.findByText('A resposta não está mais disponível para download. Envie de novo.')).toBeInTheDocument()
    })
  })

  describe('dados sensíveis no gravador HAR', () => {
    const recordAndExport = async () => {
      listEnvironments.mockResolvedValue({
        ok: true,
        value: {
          environments: [{ id: 'env-dev', name: 'Development', variables: [{ name: 'apiKey', value: 's3cr3t', sensitive: true }] }],
          activeEnvironmentId: 'env-dev',
        },
      })
      executeGraphqlRequest.mockResolvedValue({
        ok: true,
        value: {
          statusCode: 200,
          durationMs: 12,
          sizeBytes: 12,
          body: { kind: 'inline', body: '{"data":{}}' },
          bodyEncoding: 'text',
          requestHeaders: [
            { name: 'authorization', value: 'Bearer abc-token' },
            { name: 'x-trace', value: 'trace-s3cr3t' },
          ],
          cookies: [],
          connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
          finalUrl: null,
          waitingMs: 3,
          environmentChanges: [],
          scriptLogs: [],
          scriptError: null,
          headers: [{ name: 'set-cookie', value: 'sid=cookie-value; Path=/' }],
          graphqlErrors: [],
        },
      })
      pickExportFile.mockResolvedValue('/tmp/session.har')
      exportHar.mockResolvedValue({ ok: true })

      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('GraphQL')
      fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://api.test/graphql?key={{apiKey}}' } })

      fireEvent.click(screen.getByRole('button', { name: 'Abrir gravador HAR' }))
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar gravação' }))
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Salvar .har' })).toBeEnabled())

      fireEvent.click(screen.getByRole('button', { name: 'Salvar .har' }))
      await waitFor(() => expect(exportHar).toHaveBeenCalledTimes(1))
      const [, content] = exportHar.mock.calls[0] as [string, string]
      return content
    }

    it('mostra route params comuns no recorder e oculta os derivados de variável sensível', async () => {
      listEnvironments.mockResolvedValue({
        ok: true,
        value: {
          environments: [
            {
              id: 'env-dev',
              name: 'Development',
              variables: [{ name: 'apiKey', value: 's3cr3t', sensitive: true }],
            },
          ],
          activeEnvironmentId: 'env-dev',
        },
      })
      executeRestRequest.mockResolvedValue({
        ok: true,
        value: {
          statusCode: 200,
          durationMs: 12,
          sizeBytes: 2,
          body: { kind: 'inline', body: '{}' },
          bodyEncoding: 'text',
          requestHeaders: [],
          cookies: [],
          connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
          finalUrl: null,
          waitingMs: 3,
          environmentChanges: [],
          scriptLogs: [],
          scriptError: null,
          headers: [],
        },
      })
      pickExportFile.mockResolvedValue('/tmp/session.har')
      exportHar.mockResolvedValue({ ok: true })

      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('REST')
      fireEvent.change(screen.getByLabelText('Endpoint'), {
        target: { value: 'https://api.test/users/:userId' },
      })

      const routeValue = screen.getByLabelText('Valor da variável de caminho userId')
      fireEvent.change(routeValue, { target: { value: '42' } })
      fireEvent.click(screen.getByRole('button', { name: 'Abrir gravador HAR' }))
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar gravação' }))
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
      await waitFor(() => expect(executeRestRequest).toHaveBeenCalledTimes(1))

      fireEvent.change(routeValue, { target: { value: '{{apiKey}}' } })
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
      await waitFor(() => expect(executeRestRequest).toHaveBeenCalledTimes(2))

      expect(screen.getByText('https://api.test/users/42')).toBeInTheDocument()
      expect(screen.getByText('https://api.test/users/{{apiKey}}')).toBeInTheDocument()
      expect(screen.queryByText(/s3cr3t/)).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Salvar .har' }))
      await waitFor(() => expect(exportHar).toHaveBeenCalledTimes(1))
      const [, content] = exportHar.mock.calls[0] as [string, string]
      const entries = JSON.parse(content).log.entries
      expect(entries.map((entry: { request: { url: string } }) => entry.request.url)).toEqual([
        'https://api.test/users/42',
        'https://api.test/users/{{apiKey}}',
      ])
      expect(content).not.toContain('s3cr3t')
    })

    it('oculta autorização, cookies e variáveis sensíveis na visualização e no .har por padrão', async () => {
      const content = await recordAndExport()

      expect(content).not.toContain('abc-token')
      expect(content).not.toContain('s3cr3t')
      expect(content).not.toContain('cookie-value')
      const [entry] = JSON.parse(content).log.entries
      expect(entry.request.url).toBe('https://api.test/graphql?key={{apiKey}}')
      expect(entry.request.headers).toContainEqual({ name: 'authorization', value: 'Bearer ••••••••' })
      expect(entry.request.headers).toContainEqual({ name: 'x-trace', value: 'trace-{{apiKey}}' })
      expect(entry.response.headers).toContainEqual({ name: 'set-cookie', value: 'sid=••••••••; Path=/' })

      expect(screen.getByText('Dados sensíveis ocultos')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /api\.test\/graphql/ }))
      const inspector = screen.getByLabelText('Inspetor da captura HAR')
      fireEvent.click(within(inspector).getByRole('tab', { name: 'Requisição' }))
      expect(inspector).not.toHaveTextContent('abc-token')
      expect(inspector).not.toHaveTextContent('s3cr3t')
    })

    it('mostra os dados reais depois do opt-out em Configurações', async () => {
      window.localStorage.setItem('alcy:security:har-redact-sensitive', 'false')
      const content = await recordAndExport()

      const [entry] = JSON.parse(content).log.entries
      expect(entry.request.url).toBe('https://api.test/graphql?key=s3cr3t')
      expect(entry.request.headers).toContainEqual({ name: 'authorization', value: 'Bearer abc-token' })
      expect(entry.response.headers).toContainEqual({ name: 'set-cookie', value: 'sid=cookie-value; Path=/' })
      expect(screen.getByText('Dados sensíveis visíveis')).toBeInTheDocument()
    })
  })

  it('filtra e apaga chamadas do console', async () => {
    const ok = {
      statusCode: 200,
      durationMs: 5,
      sizeBytes: 2,
      body: { kind: 'inline', body: '{}' },
      bodyEncoding: 'text',
      requestHeaders: [],
      cookies: [],
      connection: { remoteAddress: null, httpVersion: 'HTTP/1.1', tlsCertificatePresent: false, certificateVerificationDisabled: false },
      finalUrl: null,
      waitingMs: 1,
      environmentChanges: [],
      scriptLogs: [],
      scriptError: null,
      headers: [],
      graphqlErrors: [],
    }
    executeGraphqlRequest.mockResolvedValueOnce({ ok: true, value: ok })
    executeGraphqlRequest.mockResolvedValueOnce({ ok: true, value: { ...ok, statusCode: 500 } })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir console de requisições' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Ver detalhes da requisição' })).toHaveLength(2))

    const filter = within(screen.getByRole('tabpanel', { name: 'Console' })).getByLabelText('Filtrar chamadas')
    fireEvent.change(filter, { target: { value: 'status:5xx' } })
    expect(screen.getAllByRole('button', { name: 'Ver detalhes da requisição' })).toHaveLength(1)

    fireEvent.change(filter, { target: { value: 'zzz-inexistente' } })
    expect(screen.getByText('Nenhuma chamada corresponde ao filtro.')).toBeInTheDocument()

    fireEvent.change(filter, { target: { value: '' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Apagar chamada' })[0])
    expect(screen.getAllByRole('button', { name: 'Ver detalhes da requisição' })).toHaveLength(1)
  })

  it('copia o corpo da resposta ao clicar no botão de copiar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body: { kind: 'inline', body: '{"data":{}}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    expect(screen.getByRole('button', { name: 'Copiar resposta' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)

    fireEvent.click(screen.getByRole('button', { name: 'Copiar resposta' }))

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('{"data":{}}'))
    expect(await screen.findByText('Resposta copiada.')).toBeInTheDocument()

    vi.unstubAllGlobals()
  })

  it('limpa a resposta ao clicar no botão de limpar', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body: { kind: 'inline', body: '{"data":{}}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    expect(screen.getByRole('button', { name: 'Limpar resposta' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)

    fireEvent.click(screen.getByRole('button', { name: 'Limpar resposta' }))

    expect(screen.getByText('Nenhuma requisição enviada')).toBeInTheDocument()
  })

  it('move o painel de resposta para a lateral direita e volta para a parte inferior', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    expect(document.querySelector('.rw-response-wrapper--bottom')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mover painel de resposta para a lateral direita' }))
    expect(document.querySelector('.rw-response-wrapper--right')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mover painel de resposta para a parte inferior' }))
    expect(document.querySelector('.rw-response-wrapper--bottom')).toBeInTheDocument()
  })

  it('keeps the response under the request when the area is too narrow for both side by side', async () => {
    // An open chat or sidebar narrows the request/response area without shrinking the window.
    class NarrowAreaObserver {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe(element: Element) {
        if (element.classList.contains('rw-request-response-layout')) {
          this.callback([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
        }
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', NarrowAreaObserver)
    try {
      render()
      await screen.findByLabelText('Ambiente')
      createRequestFromTabsBar('GraphQL')
      expect(document.querySelector('.rw-response-wrapper--bottom')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Mover painel de resposta para a lateral direita' })).toBeDisabled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('mantém a posição do painel de resposta entre sessões', async () => {
    const { unmount } = render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Mover painel de resposta para a lateral direita' }))
    expect(window.localStorage.getItem('alcy:panel:response-layout')).toBe('right')
    unmount()

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    expect(document.querySelector('.rw-response-wrapper--right')).toBeInTheDocument()
  })

  it('mostra os erros GraphQL na aba Errors e sinaliza no resumo', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 82,
        sizeBytes: 12,
        body: { kind: 'inline', body: '{"data":null,"errors":[{"message":"Not authorized"}]}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [{ message: 'Not authorized', path: ['currentCustomer'], locations: [] }],
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)

    expect(screen.getByText(/GraphQL: Error/)).toBeInTheDocument()

    const responsePanel = screen.getByRole('region', { name: 'Resposta da requisição' })
    fireEvent.click(within(responsePanel).getByRole('tab', { name: 'Errors' }))

    expect(within(responsePanel).getByText('Not authorized')).toBeInTheDocument()
    expect(within(responsePanel).getByText('Caminho: currentCustomer')).toBeInTheDocument()
  })

  it('inclui as variáveis do ambiente ativo ao enviar', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: { statusCode: 200, durationMs: 10, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    openEnvironmentsTab()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))
    fireEvent.change(screen.getByPlaceholderText('nome'), { target: { value: 'baseUrl' } })
    fireEvent.change(screen.getByPlaceholderText('valor'), { target: { value: 'https://api.example.com' } })

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)

    expect(executeGraphqlRequest).toHaveBeenCalledTimes(1)
    const call = executeGraphqlRequest.mock.calls[0][0]
    expect(call.environmentVariables).toEqual([{ name: 'baseUrl', value: 'https://api.example.com', sensitive: false }])
  })

  it('envia a requisição ao pressionar Enter no campo de endpoint', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: { statusCode: 200, durationMs: 10, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.keyDown(screen.getByLabelText('Endpoint'), { key: 'Enter' })
    await findStatusText(/200/)

    expect(executeGraphqlRequest).toHaveBeenCalledTimes(1)
  })

  it('envia a requisição ao pressionar Enter com a aba ativa, sem foco em campo', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: { statusCode: 200, durationMs: 10, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    const tab = within(screen.getByRole('tablist', { name: 'Requisições abertas' })).getByRole('tab', { name: 'Nova requisição' })
    fireEvent.click(tab)
    fireEvent.keyDown(tab, { key: 'Enter' })
    await findStatusText(/200/)
    expect(executeGraphqlRequest).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document.body, { key: 'Enter' })
    await waitFor(() => expect(executeGraphqlRequest).toHaveBeenCalledTimes(2))
  })

  it('não envia a requisição ao pressionar Enter no editor de query', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.keyDown(screen.getByLabelText('Query GraphQL'), { key: 'Enter' })

    expect(executeGraphqlRequest).not.toHaveBeenCalled()
  })

  it('usa Enter no localizador do editor para avançar sem enviar a requisição', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    pasteIntoQueryEditor('Alpha alpha alphabet')

    const editor = screen.getByLabelText('Query GraphQL')
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('textbox', { name: 'Texto para localizar' })
    fireEvent.change(input, { target: { value: 'alpha' } })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('2 de 3')).toBeInTheDocument()
    expect(executeGraphqlRequest).not.toHaveBeenCalled()
  })

  it('alterna as abas abertas com Ctrl+Tab de forma circular', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')
    createRequestFromTabsBar('REST')
    createRequestFromTabsBar('REST')
    const openTabsBar = () => screen.getByRole('tablist', { name: 'Requisições abertas' })
    const tabs = within(openTabsBar()).getAllByRole('tab')
    const selectedTab = () => within(openTabsBar()).getByRole('tab', { selected: true })

    fireEvent.click(tabs[0])
    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true })
    expect(selectedTab()).toBe(tabs[1])
    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true })
    expect(selectedTab()).toBe(tabs[2])
    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true })
    expect(selectedTab()).toBe(tabs[0])

    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(selectedTab()).toBe(tabs[2])
  })

  it('usa os atalhos configurados: o alternativo envia e o removido não troca de aba', async () => {
    window.localStorage.setItem(
      'alcy:shortcuts',
      JSON.stringify({ version: 1, bindings: { sendRequest: ['F5', 'Ctrl+Enter'], nextTab: [] } }),
    )
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: { statusCode: 200, durationMs: 10, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    createRequestFromTabsBar('GraphQL')
    const tabs = within(screen.getByRole('tablist', { name: 'Requisições abertas' })).getAllByRole('tab')
    const selectedTab = () =>
      within(screen.getByRole('tablist', { name: 'Requisições abertas' })).getByRole('tab', { selected: true })

    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true })
    expect(selectedTab()).toBe(tabs[1])
    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(selectedTab()).toBe(tabs[0])

    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(screen.getByLabelText('Endpoint'), { key: 'Enter', ctrlKey: true })
    await findStatusText(/200/)
    expect(executeGraphqlRequest).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document.body, { key: 'F5' })
    await waitFor(() => expect(executeGraphqlRequest).toHaveBeenCalledTimes(2))
  })

  it('Ctrl+N/Ctrl+T abrem os tipos de requisição e Ctrl+W fecha a aba ativa, confirmando o descarte', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true })
    fireEvent.click(screen.getByRole('option', { name: 'HTTP' }))
    fireEvent.keyDown(document.body, { key: 't', ctrlKey: true })
    fireEvent.click(screen.getByRole('option', { name: 'HTTP' }))
    const openTabs = () => within(screen.getByRole('tablist', { name: 'Requisições abertas' })).queryAllByRole('tab')
    expect(openTabs()).toHaveLength(2)

    // A never-saved draft is dirty and asks for confirmation when closed.
    fireEvent.keyDown(document.body, { key: 'w', ctrlKey: true })
    const dialog = screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })
    expect(openTabs()).toHaveLength(2)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Descartar' }))
    expect(openTabs()).toHaveLength(1)
  })

  it('Ctrl+\\ esconde e mostra a barra lateral e Ctrl+, abre as configurações', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    fireEvent.keyDown(document.body, { key: '\\', ctrlKey: true })
    expect(screen.getByRole('button', { name: 'Mostrar barra lateral' })).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: '\\', ctrlKey: true })
    expect(screen.getByRole('button', { name: 'Esconder barra lateral' })).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: ',', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Configurações' })).toBeVisible()
  })

  it('Ctrl+O mostra as collections, mesmo com a barra lateral escondida, e abre a importação', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    fireEvent.keyDown(document.body, { key: '\\', ctrlKey: true })

    fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true })

    expect(screen.getByRole('complementary', { name: 'Collections' })).toBeInTheDocument()
    expect(await screen.findByRole('dialog', { name: 'Importar Collection' })).toBeInTheDocument()
  })

  it('Ctrl+Shift+N cria uma collection já em modo de renomear', async () => {
    // Finish the initial workspace loads before issuing a creation shortcut.
    await act(async () => { render() })
    await screen.findByLabelText('Ambiente')

    fireEvent.keyDown(document.body, { key: 'N', ctrlKey: true, shiftKey: true })

    const sidebar = screen.getByRole('complementary', { name: 'Collections' })
    expect(within(sidebar).getByLabelText('Nome')).toHaveValue('Nova Collection')
  })

  it('mostra uma mensagem distinta para erro de rede', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'connection refused' },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    expect(await screen.findByText('Falha de rede: connection refused')).toBeInTheDocument()
  })

  it('descreve a causa reconhecida da falha de rede e mostra o detalhe técnico', async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: false,
      error: {
        kind: 'network',
        message: 'tcp connect error: Connection refused (os error 111)',
        cause: { type: 'connectionRefused' },
      },
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    expect(
      await screen.findByText('O servidor recusou a conexão. Confira se ele está rodando e se a porta está correta.'),
    ).toBeInTheDocument()
    expect(screen.getByText('tcp connect error: Connection refused (os error 111)')).toBeInTheDocument()
  })

  it('grava no ambiente as variáveis do pré-script mesmo quando o envio falha', async () => {
    executeRestRequest.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'connection refused' },
      environmentChanges: [{ name: 'token', value: 'abc' }],
      scriptLogs: ['pre'],
    })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(await screen.findByText('Falha de rede: connection refused')).toBeInTheDocument()

    openEnvironmentsTab()
    expect(screen.getByDisplayValue('token')).toBeInTheDocument()
    expect(screen.getByDisplayValue('abc')).toBeInTheDocument()
  })

  it('mostra uma mensagem distinta para timeout', async () => {
    executeGraphqlRequest.mockResolvedValue({ ok: false, error: { kind: 'timeout' } })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    expect(await screen.findByText('Tempo de execução esgotado.')).toBeInTheDocument()
  })

  it('mostra o botão Cancelar durante o carregamento e aciona o cancelamento', async () => {
    let resolveExecution: (value: unknown) => void = () => {}
    executeGraphqlRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExecution = resolve
        }),
    )

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    const cancelButton = await screen.findByRole('button', { name: 'Cancelar' })
    fireEvent.click(cancelButton)

    expect(cancelGraphqlRequest).toHaveBeenCalledTimes(1)
    const sentExecutionId = executeGraphqlRequest.mock.calls[0][0].executionId
    expect(cancelGraphqlRequest).toHaveBeenCalledWith(sentExecutionId)

    resolveExecution({ ok: false, error: { kind: 'cancelled' } })
    expect(await screen.findByText('Execução cancelada.')).toBeInTheDocument()
  })

  it('adiciona, edita e remove um header', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar header' }))

    const nameInput = screen.getByPlaceholderText('Nome')
    const valueInput = screen.getByPlaceholderText('Valor')
    fireEvent.change(nameInput, { target: { value: 'X-Request-Id' } })
    fireEvent.change(valueInput, { target: { value: 'abc-123' } })

    expect(nameInput).toHaveValue('X-Request-Id')
    expect(valueInput).toHaveValue('abc-123')

    fireEvent.click(screen.getByRole('button', { name: /Remover header/ }))
    expect(screen.queryByPlaceholderText('Nome')).not.toBeInTheDocument()
  })

  it('troca o ambiente ativo e reflete no topo e na sidebar', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    openEnvironmentsTab()

    fireEvent.change(screen.getByLabelText('Ambiente'), { target: { value: 'env-prod' } })

    expect(screen.getByLabelText('Ambiente')).toHaveValue('env-prod')
    expect(within(environmentList()).getByText('Production')).toBeInTheDocument()
    expect(within(environmentList()).getByRole('button', { name: 'Production ativo' })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('não reescreve alcy-environments.json ao só carregar o workspace, sem nenhuma edição', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()

    // Wait beyond the 500 ms autosave debounce without edits: loading is not editing.
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(saveEnvironments).not.toHaveBeenCalled()
  })

  it('cria, renomeia e remove um ambiente pela sidebar usando o menu de opções da linha', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    openEnvironmentsTab()

    fireEvent.click(screen.getByRole('button', { name: 'Novo ambiente' }))
    expect(within(environmentList()).getByText('Novo ambiente')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de Novo ambiente' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
    const nameInput = screen.getByLabelText('Nome do ambiente')
    expect(nameInput).toHaveValue('Novo ambiente')

    fireEvent.change(nameInput, { target: { value: 'QA' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })

    expect(within(environmentList()).getByText('QA')).toBeInTheDocument()
    expect(screen.queryByLabelText('Nome do ambiente')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mais opções de QA' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }))
    const dialog = screen.getByRole('dialog', { name: 'Remover ambiente?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }))
    expect(screen.queryByText('QA')).not.toBeInTheDocument()
  })

  it('adiciona uma variável de ambiente e revela/oculta um valor sensível', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    openEnvironmentsTab()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))

    fireEvent.change(screen.getByPlaceholderText('nome'), { target: { value: 'token' } })
    fireEvent.change(screen.getByPlaceholderText('valor'), { target: { value: 'secret' } })
    expect(screen.getByPlaceholderText('valor')).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByLabelText('Marcar token como sensível'))
    expect(screen.getByPlaceholderText('valor')).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: /Revelar/ }))
    expect(screen.getByPlaceholderText('valor')).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: /Remover variável token/ }))
    expect(screen.queryByPlaceholderText('nome')).not.toBeInTheDocument()
  })

  it('destaca {{baseUrl}} como desconhecida e depois como conhecida ao definir a variável', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: '{{baseUrl}}/' } })
    openEnvironmentsTab()

    const unknownToken = document.querySelector('.var-token--unknown')
    expect(unknownToken).toHaveTextContent('{{baseUrl}}')

    hoverTemplateToken(unknownToken as Element)
    expect(await screen.findByText('Não existe no ambiente ativo nem na coleção.')).toBeInTheDocument()
    expect(document.querySelector('.var-preview--undefined .var-preview-badge')).toHaveTextContent('Indefinida')
    unhoverTemplateToken(unknownToken as Element)

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))
    fireEvent.change(screen.getByPlaceholderText('nome'), { target: { value: 'baseUrl' } })
    fireEvent.change(screen.getByPlaceholderText('valor'), { target: { value: 'https://api.example.com' } })

    const knownToken = document.querySelector('.var-token--known')
    expect(knownToken).toHaveTextContent('{{baseUrl}}')
    expect(document.querySelector('.var-token--unknown')).not.toBeInTheDocument()

    hoverTemplateToken(knownToken as Element)
    expect(document.querySelector('.var-preview--defined .var-preview-name')).toHaveTextContent('baseUrl')
    const previewValue = await screen.findByLabelText('Valor da variável baseUrl')
    expect(previewValue).toHaveValue('https://api.example.com')

    // Editing the variable preview writes to the active environment.
    fireEvent.change(previewValue, { target: { value: 'https://staging.example.com' } })
    expect(screen.getByPlaceholderText('valor')).toHaveValue('https://staging.example.com')
  })

  it('cria uma variável indefinida pela pré-visualização', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: '{{host}}/' } })
    openEnvironmentsTab()

    hoverTemplateToken(document.querySelector('.var-token--unknown') as Element)
    fireEvent.click(await screen.findByRole('button', { name: 'Criar no ambiente ativo' }))
    fireEvent.change(screen.getByLabelText('Valor da variável host'), { target: { value: 'https://api.example.com' } })

    expect(screen.getByPlaceholderText('nome')).toHaveValue('host')
    expect(screen.getByPlaceholderText('valor')).toHaveValue('https://api.example.com')
    expect(document.querySelector('.var-token--unknown')).not.toBeInTheDocument()
  })

  it('destaca e sugere variáveis do ambiente no valor de um header', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    openEnvironmentsTab()
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar variável' }))
    fireEvent.change(screen.getByPlaceholderText('nome'), { target: { value: 'token' } })
    fireEvent.change(screen.getByPlaceholderText('valor'), { target: { value: 'abc123' } })

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar header' }))
    const valueField = screen.getAllByLabelText('Valor do header').at(-1) as HTMLInputElement
    fireEvent.change(valueField, { target: { value: 'Bearer {{' } })
    expect(screen.getByRole('listbox', { name: 'Sugestões de variáveis' })).toHaveTextContent('token')

    fireEvent.keyDown(valueField, { key: 'Enter' })
    expect(valueField).toHaveValue('Bearer {{token}}')
    const headersTable = screen.getByRole('table', { name: 'Headers da requisição' })
    expect(headersTable.querySelector('.var-token--known')).toHaveTextContent('{{token}}')
  })

  it('recolhe e expande a sidebar de ambientes', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    openEnvironmentsTab()

    fireEvent.click(screen.getByRole('button', { name: 'Esconder barra lateral' }))
    expect(screen.queryByRole('button', { name: 'Novo ambiente' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Ambientes' }))
    expect(screen.getByRole('button', { name: 'Novo ambiente' })).toBeInTheDocument()
  })

  describe('Collections e pastas', () => {
    const collectionsSidebar = () => screen.getByRole('complementary', { name: 'Collections' })
    const openCollectionsTab = () => {
      const collectionsTab = screen.getByRole('tab', { name: 'Componentes' })
      if (collectionsTab.getAttribute('aria-selected') !== 'true') fireEvent.click(collectionsTab)
    }
    const openMenu = (name: string) =>
      fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: `Mais opções de ${name}` }))
    const addRequestButton = () => within(collectionsSidebar()).getByRole('button', { name: 'Adicionar requisição' })
    /** Folder request creation uses the default name; rename through the tree when another name is requested. */
    const addRequestTo = (folder: string, name: string, protocol: 'GraphQL' | 'HTTP' = 'GraphQL') => {
      openMenu(folder)
      fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar requisição' }))
      fireEvent.click(screen.getByRole('option', { name: protocol }))
      if (name === 'Nova requisição') return
      openMenu('Nova requisição')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
      const nameInput = within(collectionsSidebar()).getByLabelText('Nome')
      fireEvent.change(nameInput, { target: { value: name } })
      fireEvent.keyDown(nameInput, { key: 'Enter' })
    }
    const openMoreMenu = () =>
      fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: 'Mais opções' }))
    const createCollection = () => {
      fireEvent.click(addRequestButton())
      fireEvent.click(screen.getByRole('option', { name: 'Criar Collection' }))
    }
    const openImportModal = () =>
      fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: 'Importar Collection' }))
    const importModal = () => screen.getByRole('dialog', { name: 'Importar Collection' })
    const clickChooseFileToImport = () => {
      openImportModal()
      fireEvent.click(within(importModal()).getByRole('button', { name: 'arquivos' }))
    }
    const confirmImportReview = async () => {
      fireEvent.click(await within(importModal()).findByRole('button', { name: 'Importar' }))
    }

    it('troca para a aba Collections e mostra o estado vazio', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()

      openCollectionsTab()

      expect(collectionsSidebar()).toBeInTheDocument()
      expect(within(collectionsSidebar()).getByText('Nenhuma Collection ainda.')).toBeInTheDocument()
    })

    it('cria uma Collection, uma subpasta e as renomeia', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      expect(within(collectionsSidebar()).getByText('Nova Collection')).toBeInTheDocument()

      openMenu('Nova Collection')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))

      const folderNameInput = within(collectionsSidebar()).getByLabelText('Nome')
      expect(folderNameInput).toHaveValue('Nova pasta')

      fireEvent.change(folderNameInput, { target: { value: 'Authentication' } })
      fireEvent.keyDown(folderNameInput, { key: 'Enter' })

      expect(within(collectionsSidebar()).getByText('Authentication')).toBeInTheDocument()

      openMenu('Nova Collection')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
      const collectionNameInput = within(collectionsSidebar()).getByLabelText('Nome')
      fireEvent.change(collectionNameInput, { target: { value: 'Customer API' } })
      fireEvent.keyDown(collectionNameInput, { key: 'Enter' })

      expect(within(collectionsSidebar()).getByText('Customer API')).toBeInTheDocument()
      expect(within(collectionsSidebar()).queryByText('Nova Collection')).not.toBeInTheDocument()
    })

    it('salva uma edição pendente imediatamente ao desmontar antes do debounce de autosave', async () => {
      const view = render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      // Still within the 500 ms debounce; ordinary autosave should not have fired.
      expect(saveCollections).not.toHaveBeenCalled()

      view.unmount()

      expect(saveCollections).toHaveBeenCalledTimes(1)
      const [rootPath, body] = saveCollections.mock.calls[0]
      expect(rootPath).toBe('/workspace')
      expect(body).toEqual([expect.objectContaining({ name: 'Nova Collection' })])
    })

    it('salva uma edição pendente ao executar o fechamento centralizado do app', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      expect(saveCollections).not.toHaveBeenCalled()
      await runBeforeExit()

      expect(saveCollections).toHaveBeenCalledTimes(1)
      const [rootPath, body] = saveCollections.mock.calls[0]
      expect(rootPath).toBe('/workspace')
      expect(body).toEqual([expect.objectContaining({ name: 'Nova Collection' })])
    })

    it('abre o menu de opções sob demanda e fecha com Escape sem executar nenhuma ação', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()

      openMenu('Nova Collection')
      const menu = screen.getByRole('menu', { name: 'Mais opções de Nova Collection' })
      expect(collectionsSidebar()).not.toContainElement(menu)
      expect(menu.parentElement).toBe(document.body)
      expect(within(menu).getByRole('menuitem', { name: 'Adicionar pasta' })).toBeInTheDocument()
      expect(within(menu).getByRole('menuitem', { name: 'Renomear' })).toBeInTheDocument()
      expect(within(menu).getByRole('menuitem', { name: 'Remover' })).toBeInTheDocument()

      fireEvent.pointerDown(within(menu).getByRole('menuitem', { name: 'Renomear' }))
      expect(menu).toBeInTheDocument()
      fireEvent.keyDown(menu, { key: 'Escape' })

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(within(collectionsSidebar()).getByText('Nova Collection')).toBeInTheDocument()
    })

    it('gera um nome livre ao criar duas Collections seguidas', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      expect(within(collectionsSidebar()).getByText('Nova Collection')).toBeInTheDocument()
      expect(within(collectionsSidebar()).getByText('Nova Collection 2')).toBeInTheDocument()
    })

    it('recolhe e expande uma pasta com subpastas', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      openMenu('Nova Collection')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      expect(within(collectionsSidebar()).getByText('Nova pasta')).toBeInTheDocument()

      fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: 'Recolher Nova Collection' }))
      expect(within(collectionsSidebar()).queryByText('Nova pasta')).not.toBeInTheDocument()

      fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: 'Expandir Nova Collection' }))
      expect(within(collectionsSidebar()).getByText('Nova pasta')).toBeInTheDocument()
    })

    it('expande e recolhe uma pasta clicando em qualquer lugar da linha, não só no chevron', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      openMenu('Nova Collection')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      expect(within(collectionsSidebar()).getByText('Nova pasta')).toBeInTheDocument()

      fireEvent.click(within(collectionsSidebar()).getByText('Nova Collection'))
      expect(within(collectionsSidebar()).queryByText('Nova pasta')).not.toBeInTheDocument()

      fireEvent.click(within(collectionsSidebar()).getByText('Nova Collection'))
      expect(within(collectionsSidebar()).getByText('Nova pasta')).toBeInTheDocument()
    })

    it('entra no modo de renomeação ao selecionar uma Collection e apertar F2', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      const row = within(collectionsSidebar()).getByText('Nova Collection').closest('.collections-row')!
      fireEvent.click(row)
      fireEvent.keyDown(row, { key: 'F2' })

      const nameInput = within(collectionsSidebar()).getByLabelText('Nome')
      expect(nameInput).toHaveValue('Nova Collection')

      fireEvent.change(nameInput, { target: { value: 'Customer API' } })
      fireEvent.keyDown(nameInput, { key: 'Enter' })

      expect(within(collectionsSidebar()).getByText('Customer API')).toBeInTheDocument()
    })

    it('não renomeia com clique duplo', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      addRequestTo('Nova Collection', 'Ping')

      fireEvent.doubleClick(within(collectionsSidebar()).getByText('Nova Collection'))
      fireEvent.doubleClick(within(collectionsSidebar()).getByText('Ping'))

      expect(within(collectionsSidebar()).queryByLabelText('Nome')).not.toBeInTheDocument()
    })

    it('entra no modo de renomeação ao selecionar uma requisição e apertar F2', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      addRequestTo('Nova Collection', 'Ping')

      const row = within(collectionsSidebar()).getByText('Ping').closest('.collections-row')!
      fireEvent.click(row)
      fireEvent.keyDown(row, { key: 'F2' })

      const nameInput = within(collectionsSidebar()).getByLabelText('Nome')
      expect(nameInput).toHaveValue('Ping')

      fireEvent.change(nameInput, { target: { value: 'Health check' } })
      fireEvent.keyDown(nameInput, { key: 'Enter' })

      expect(within(collectionsSidebar()).getByText('Health check')).toBeInTheDocument()
    })

    it('abre uma requisição clicando em qualquer parte da linha, não só sobre o texto', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

      addRequestTo('Nova Collection', 'Ping')

      addRequestTo('Nova Collection', 'Pong')

      expect(within(collectionsSidebar()).getByText('Ping')).toHaveAttribute('aria-current', 'false')

      const row = within(collectionsSidebar()).getByText('Ping').closest('.collections-row')!
      fireEvent.click(row)

      expect(within(collectionsSidebar()).getByText('Ping')).toHaveAttribute('aria-current', 'true')
      const breadcrumb = screen.getByRole('navigation', { name: 'Caminho da requisição' })
      expect(within(breadcrumb).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        'Nova Collection',
        'Ping',
      ])
    })

    it('remove uma Collection', async () => {
      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      createCollection()
      fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      expect(within(collectionsSidebar()).getByText('Nova Collection')).toBeInTheDocument()

      openMenu('Nova Collection')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }))

      const dialog = screen.getByRole('dialog', { name: 'Excluir “Nova Collection”?' })
      fireEvent.change(within(dialog).getByLabelText('Digite “delete” para confirmar'), { target: { value: 'delete' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir Collection' }))

      expect(within(collectionsSidebar()).queryByText('Nova Collection')).not.toBeInTheDocument()
      expect(within(collectionsSidebar()).getByText('Nenhuma Collection ainda.')).toBeInTheDocument()
    })

    it('carrega as Collections persistidas do workspace ao montar', async () => {
      listCollections.mockResolvedValue({
        ok: true,
        value: [{ id: 'collection-1', name: 'Customer API', folders: [], requests: [] }],
      })

      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      expect(await within(collectionsSidebar()).findByText('Customer API')).toBeInTheDocument()
      expect(listCollections).toHaveBeenCalledWith('/workspace')
    })

    it('não reescreve alcy-collections.json ao só carregar o workspace, sem nenhuma edição', async () => {
      listCollections.mockResolvedValue({
        ok: true,
        value: [{ id: 'collection-1', name: 'Customer API', folders: [], requests: [] }],
      })

      render()
      await screen.findByLabelText('Ambiente')
      await createRequestFromEmptyState()
      openCollectionsTab()

      expect(await within(collectionsSidebar()).findByText('Customer API')).toBeInTheDocument()

      // Wait beyond the 500 ms autosave debounce without edits: loading is not editing.
      await new Promise((resolve) => setTimeout(resolve, 600))

      expect(saveCollections).not.toHaveBeenCalled()
    })

    describe('importar e exportar Collections', () => {
      it('o "+" da sidebar oferece "Criar Collection" separado dos tipos de requisição; o "+" das abas não', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        expect(within(collectionsSidebar()).getByRole('button', { name: 'Importar Collection' })).toBeInTheDocument()
        expect(within(collectionsSidebar()).queryByRole('button', { name: 'Mais opções' })).not.toBeInTheDocument()

        fireEvent.click(addRequestButton())
        const types = screen.getByRole('listbox', { name: 'Tipos de requisição' })
        expect(within(types).getAllByRole('option').map((option) => option.textContent)).toEqual([
          'HTTPHTTP',
          'GQLGraphQL',
          'gRPCgRPC',
          'WSWebSocket',
          'Criar Collection',
        ])
        expect(within(types).getByRole('separator')).toBeInTheDocument()

        fireEvent.keyDown(types, { key: 'Escape' })
        expect(screen.queryByRole('listbox', { name: 'Tipos de requisição' })).not.toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Nenhuma Collection ainda.')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Nova aba' }))
        expect(screen.getByRole('listbox', { name: 'Tipos de requisição' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Criar Collection' })).not.toBeInTheDocument()
      })

      it('"Criar Collection" do "+" da sidebar responde ao teclado e abre a nova Collection em renomeação', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        fireEvent.click(addRequestButton())
        const types = screen.getByRole('listbox', { name: 'Tipos de requisição' })
        // HTTP → GraphQL → gRPC → WebSocket → Criar Collection.
        fireEvent.keyDown(types, { key: 'ArrowDown' })
        fireEvent.keyDown(types, { key: 'ArrowDown' })
        fireEvent.keyDown(types, { key: 'ArrowDown' })
        fireEvent.keyDown(types, { key: 'ArrowDown' })
        fireEvent.keyDown(types, { key: 'Enter' })

        expect(screen.queryByRole('listbox', { name: 'Tipos de requisição' })).not.toBeInTheDocument()
        expect(within(collectionsSidebar()).getByDisplayValue('Nova Collection')).toBeInTheDocument()
      })

      it('offers Alcy export for collections and empty folders', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        createCollection()
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
        expect(screen.getByRole('menuitem', { name: 'Formato Alcy' })).toBeInTheDocument()
        fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

        openMenu('Nova pasta')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
        expect(screen.getByRole('menuitem', { name: 'Formato Alcy' })).toBeEnabled()
        expect(screen.getByRole('menuitem', { name: 'Como webclient' })).toBeDisabled()
      })

      it('exports folders directly when the webclient flag is disabled', async () => {
        featureFlags.webclientExport = false
        pickExportFile.mockResolvedValue('/export/customer-api.alcy.json')
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        createCollection()
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        openMenu('Nova pasta')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
        await vi.waitFor(() => expect(exportCollections).toHaveBeenCalledWith(
          '/export/customer-api.alcy.json',
          [expect.objectContaining({ name: 'Nova pasta', folders: [], requests: [] })],
        ))
        expect(pickExportFile).toHaveBeenCalledWith('Nova pasta')

        expect(screen.queryByRole('menuitem', { name: 'Como webclient' })).toBeNull()
        await vi.waitFor(() => expect(exportCollections).toHaveBeenCalledWith('/export/customer-api.alcy.json', expect.any(Array)))
      })

      it('exporta uma única Collection pelo menu "⋯"', async () => {
        pickExportFile.mockResolvedValue('/export/customer-api.alcy.json')
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        createCollection()
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Formato Alcy' }))

        expect(pickExportFile).toHaveBeenCalledWith('Nova Collection')
        await vi.waitFor(() =>
          expect(exportCollections).toHaveBeenCalledWith(
            '/export/customer-api.alcy.json',
            [expect.objectContaining({ name: 'Nova Collection', folders: [], requests: [] })],
          ),
        )
      })

      it('cancela a exportação sem chamar o backend quando o diálogo de salvar é fechado', async () => {
        pickExportFile.mockResolvedValue(null)
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        createCollection()
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Exportar' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Formato Alcy' }))

        await vi.waitFor(() => expect(pickExportFile).toHaveBeenCalled())
        expect(exportCollections).not.toHaveBeenCalled()
      })

      it('exporta todas as Collections pelo "Exportar tudo" do menu "..."', async () => {
        pickExportFile.mockResolvedValue('/export/workspace.alcy.json')
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        createCollection()
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        openMoreMenu()
        fireEvent.click(within(collectionsSidebar()).getByRole('menuitem', { name: 'Exportar tudo' }))

        expect(pickExportFile).toHaveBeenCalledWith('workspace')
        await vi.waitFor(() =>
          expect(exportCollections).toHaveBeenCalledWith('/export/workspace.alcy.json', [
            expect.objectContaining({ name: 'Nova Collection' }),
          ]),
        )
      })

      it('não mostra o menu "..." (só com "Exportar tudo") sem nenhuma Collection', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        expect(within(collectionsSidebar()).queryByRole('button', { name: 'Mais opções' })).not.toBeInTheDocument()
      })

      it('importa um arquivo com uma Collection, deduplicando o nome contra uma já existente', async () => {
        pickImportFiles.mockResolvedValue(['/import/customer-api.alcy.json'])
        importCollections.mockResolvedValue({
          ok: true,
          value: {
            collections: [
              {
                id: 'imported-collection-1',
                name: 'Customer API',
                folders: [],
                authentication: { type: 'inherit' },
                requests: [
                  {
                    id: 'imported-request-1',
                    name: 'Ping',
                    protocol: 'graphql',
                    endpoint: '{{baseUrl}}/graphql',
                    body: 'query { ping }',
                    variables: '{}',
                    headers: [],
                    authentication: { type: 'none' },
                  },
                ],
              },
            ],
            environments: [],
          },
        })
        listCollections.mockResolvedValue({
          ok: true,
          value: [{ id: 'collection-1', name: 'Customer API', folders: [], requests: [] }],
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        await within(collectionsSidebar()).findByText('Customer API')

        clickChooseFileToImport()
        await confirmImportReview()

        expect(await within(collectionsSidebar()).findByText('Customer API 2')).toBeInTheDocument()
        expect(screen.queryByRole('dialog', { name: 'Importar Collection' })).not.toBeInTheDocument()

        fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: 'Expandir Customer API 2' }))
        expect(within(collectionsSidebar()).getByText('Ping')).toBeInTheDocument()
      })

      it('importa de uma vez todos os arquivos selecionados, incluindo Collections e ambientes', async () => {
        pickImportFiles.mockResolvedValue(['/import/collection.json', '/import/environment.json'])
        importCollections
          .mockResolvedValueOnce({
            ok: true,
            value: {
              collections: [{ id: 'imported-1', name: 'Collection A', folders: [], requests: [] }],
              environments: [],
            },
          })
          .mockResolvedValueOnce({
            ok: true,
            value: {
              collections: [],
              environments: [{ id: 'imported-env-1', name: 'Staging', variables: [] }],
            },
          })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        clickChooseFileToImport()
        await confirmImportReview()

        expect(await within(collectionsSidebar()).findByText('Collection A')).toBeInTheDocument()
        expect(importCollections).toHaveBeenNthCalledWith(1, '/import/collection.json', '/workspace')
        expect(importCollections).toHaveBeenNthCalledWith(2, '/import/environment.json', '/workspace')

        openEnvironmentsTab()
        expect(await within(environmentList()).findByText('Staging')).toBeInTheDocument()
      })

      it('mantém os sucessos e lista os arquivos que falharam em um lote', async () => {
        pickImportFiles.mockResolvedValue(['/import/valid.json', '/import/broken.json'])
        importCollections
          .mockResolvedValueOnce({
            ok: true,
            value: {
              collections: [{ id: 'imported-1', name: 'Valid API', folders: [], requests: [] }],
              environments: [],
            },
          })
          .mockResolvedValueOnce({
            ok: false,
            error: { kind: 'invalid', message: 'formato inválido' },
          })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        clickChooseFileToImport()

        const alert = await within(importModal()).findByRole('alert')
        expect(alert).toHaveTextContent('formato inválido')
        expect(alert).toHaveTextContent('broken.json')
        await confirmImportReview()
        expect(await within(collectionsSidebar()).findByText('Valid API')).toBeInTheDocument()
      })

      it('soma os scripts do lote em um único resumo e junta os toasts de sucesso', async () => {
        pickImportFiles.mockResolvedValue(['/import/a.json', '/import/b.json', '/import/c.json'])
        const imported = (id: string, scriptCount: number, warnings: number) => ({
          ok: true,
          value: {
            collections: [{ id, name: `API ${id}`, folders: [], requests: [] }],
            environments: [],
            scriptCount,
            warnings: Array.from({ length: warnings }, () => ({
              requestPath: 'Req',
              phase: 'preRequest',
              line: 1,
              api: 'pm.x',
              reason: 'unsupported',
            })),
          },
        })
        importCollections
          .mockResolvedValueOnce(imported('a', 2, 1))
          .mockResolvedValueOnce(imported('b', 0, 0))
          .mockResolvedValueOnce(imported('c', 3, 2))

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        clickChooseFileToImport()
        await confirmImportReview()

        expect(await within(collectionsSidebar()).findByText('API c')).toBeInTheDocument()
        // The detail panel stays closed until the status bar entry is clicked.
        const importStatus = screen.getByText('Importação')
        expect(importStatus.closest('button')).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('3 de 3 concluídos')).not.toBeInTheDocument()
        fireEvent.click(importStatus)
        expect(await screen.findByText('3 de 3 concluídos')).toBeInTheDocument()
        fireEvent.click(importStatus)
        expect(screen.queryByText('3 de 3 concluídos')).not.toBeInTheDocument()
        const importSlot = importStatus.closest('#rw-import-statusbar-slot')
        expect(importSlot).not.toBeNull()
        expect(importSlot?.previousElementSibling).toHaveTextContent('Console')
      })

      it('agrupa arquivos que falharam pelo mesmo motivo', async () => {
        pickImportFiles.mockResolvedValue(['/import/first.json', '/import/second.json', '/import/third.json'])
        importCollections
          .mockResolvedValueOnce({ ok: false, error: { kind: 'invalid', message: 'formato inválido' } })
          .mockResolvedValueOnce({ ok: false, error: { kind: 'invalid', message: 'formato inválido' } })
          .mockResolvedValueOnce({ ok: false, error: { kind: 'storage', message: 'arquivo ilegível' } })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        clickChooseFileToImport()

        const alert = await within(importModal()).findByRole('alert')
        expect(alert).toHaveTextContent('first.json: formato inválido')
        expect(alert).toHaveTextContent('second.json: formato inválido')
        expect(alert).toHaveTextContent('third.json: arquivo ilegível')
      })

      it('importa todos os arquivos encontrados na pasta escolhida', async () => {
        pickImportFolder.mockResolvedValue('/import/exports')
        expandImportPaths.mockResolvedValue({
          ok: true,
          value: ['/import/exports/a.json', '/import/exports/nested/b.yaml'],
        })
        importCollections
          .mockResolvedValueOnce({
            ok: true,
            value: { collections: [{ id: 'imported-1', name: 'Folder A', folders: [], requests: [] }], environments: [] },
          })
          .mockResolvedValueOnce({
            ok: true,
            value: { collections: [{ id: 'imported-2', name: 'Folder B', folders: [], requests: [] }], environments: [] },
          })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        fireEvent.click(within(importModal()).getByRole('button', { name: 'uma pasta' }))
        await confirmImportReview()

        expect(await within(collectionsSidebar()).findByText('Folder B')).toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Folder A')).toBeInTheDocument()
        expect(expandImportPaths).toHaveBeenCalledWith(['/import/exports'])
        expect(importCollections).toHaveBeenNthCalledWith(1, '/import/exports/a.json', '/workspace')
        expect(importCollections).toHaveBeenNthCalledWith(2, '/import/exports/nested/b.yaml', '/workspace')
        expect(screen.queryByRole('dialog', { name: 'Importar Collection' })).not.toBeInTheDocument()
      })

      it('avisa quando a pasta escolhida não tem arquivos importáveis', async () => {
        pickImportFolder.mockResolvedValue('/import/empty')
        expandImportPaths.mockResolvedValue({ ok: true, value: [] })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        fireEvent.click(within(importModal()).getByRole('button', { name: 'uma pasta' }))

        const alert = await within(importModal()).findByRole('alert')
        expect(alert).toHaveTextContent('Nenhum arquivo importável')
        expect(importCollections).not.toHaveBeenCalled()
      })

      it('mostra um erro inline na modal ao falhar a importação por arquivo, sem fechá-la', async () => {
        pickImportFiles.mockResolvedValue(['/import/broken.alcy.json'])
        importCollections.mockResolvedValue({
          ok: false,
          error: { kind: 'storage', message: 'não foi possível ler o arquivo' },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        clickChooseFileToImport()

        const alert = await within(importModal()).findByRole('alert')
        expect(alert).toHaveTextContent('não foi possível ler o arquivo')
        expect(importModal()).toBeInTheDocument()
      })

      it('mostra um spinner na aba Arquivo enquanto a importação está em andamento', async () => {
        pickImportFiles.mockResolvedValue(['/import/customer-api.alcy.json'])
        let resolveImport: (value: { ok: true; value: { collections: unknown[]; environments: unknown[] } }) => void =
          () => {}
        importCollections.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveImport = resolve
            }),
        )

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        clickChooseFileToImport()

        const dialog = importModal()
        expect(await within(dialog).findByText('Analisando conteúdo…')).toBeInTheDocument()
        expect(within(dialog).queryByRole('button', { name: 'arquivos' })).not.toBeInTheDocument()
        expect(dialog.querySelector('.ui-loading-bar')).toBeInTheDocument()

        resolveImport({
          ok: true,
          value: { collections: [{ id: 'imported-1', name: 'Customer API', folders: [], requests: [] }], environments: [] },
        })

        await confirmImportReview()
        expect(await within(collectionsSidebar()).findByText('Customer API')).toBeInTheDocument()
      })

      it('troca de aba na modal de importar, entre Arquivo/URL/Código', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        const dialog = importModal()
        expect(dialog).toHaveTextContent(
          'Selecione a origem dos dados.',
        )
        expect(within(dialog).getByRole('tab', { name: 'Arquivos' })).toHaveAttribute('aria-selected', 'true')

        fireEvent.click(within(dialog).getByRole('tab', { name: 'URL' }))
        expect(within(dialog).getByLabelText('URL do documento')).toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('tab', { name: 'Código' }))
        expect(within(dialog).getByLabelText('Conteúdo')).toBeInTheDocument()
      })

      it('a modal de importar fica alinhada ao topo e mantém o painel de abas com altura fixa', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        const dialog = importModal()
        expect(dialog).toHaveClass('ui-modal--top')
        expect(dialog.querySelector('.import-modal-panel')).toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('tab', { name: 'URL' }))
        expect(dialog.querySelector('.import-modal-panel--compact')).toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('tab', { name: 'Código' }))
        expect(dialog.querySelector('.import-modal-panel')).toBeInTheDocument()
        expect(dialog.querySelector('.import-modal-code-textarea')).toBeInTheDocument()
      })

      it('shows in the review how many items were skipped or imported partially', async () => {
        importCollectionsFromText.mockResolvedValue({
          ok: true,
          value: {
            collections: [{ id: 'imported-1', name: 'api.example.com', folders: [], requests: [] }],
            environments: [],
            warnings: [
              { requestPath: 'POST /upload', phase: 'body', line: null, api: 'file', reason: 'skippedFile' },
              { requestPath: 'entries[3]', phase: 'request', line: null, api: 'PROPFIND', reason: 'unsupportedMethod' },
            ],
          },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        const dialog = importModal()
        fireEvent.click(within(dialog).getByRole('tab', { name: 'Código' }))
        fireEvent.change(within(dialog).getByLabelText('Conteúdo'), { target: { value: '{"log": {"entries": []}}' } })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar' }))

        expect(await within(importModal()).findByText('2 item(ns) ignorado(s) ou importado(s) parcialmente.')).toBeInTheDocument()
      })

      it('importa uma Collection colando o conteúdo na aba Código', async () => {
        importCollectionsFromText.mockResolvedValue({
          ok: true,
          value: { collections: [{ id: 'imported-1', name: 'Pasted API', folders: [], requests: [] }], environments: [] },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        const dialog = importModal()
        fireEvent.click(within(dialog).getByRole('tab', { name: 'Código' }))
        fireEvent.change(within(dialog).getByLabelText('Conteúdo'), {
          target: { value: '{"openapi": "3.0.3", "info": {"title": "Pasted API"}, "paths": {}}' },
        })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar' }))
        await confirmImportReview()

        expect(await within(collectionsSidebar()).findByText('Pasted API')).toBeInTheDocument()
        expect(importCollectionsFromText).toHaveBeenCalledWith(
          '{"openapi": "3.0.3", "info": {"title": "Pasted API"}, "paths": {}}',
          '/workspace',
        )
      })

      it('importa uma Collection a partir de uma URL', async () => {
        importCollectionsFromUrl.mockResolvedValue({
          ok: true,
          value: { collections: [{ id: 'imported-1', name: 'Remote API', folders: [], requests: [] }], environments: [] },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        const dialog = importModal()
        fireEvent.click(within(dialog).getByRole('tab', { name: 'URL' }))
        fireEvent.change(within(dialog).getByLabelText('URL do documento'), {
          target: { value: 'https://example.com/openapi.json' },
        })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar' }))
        await confirmImportReview()

        expect(await within(collectionsSidebar()).findByText('Remote API')).toBeInTheDocument()
        expect(importCollectionsFromUrl).toHaveBeenCalledWith('https://example.com/openapi.json', '/workspace')
      })

      it('mostra um erro inline ao falhar a importação por URL, sem fechar a modal', async () => {
        importCollectionsFromUrl.mockResolvedValue({
          ok: false,
          error: { kind: 'storage', message: 'falha ao buscar URL' },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        const dialog = importModal()
        fireEvent.click(within(dialog).getByRole('tab', { name: 'URL' }))
        fireEvent.change(within(dialog).getByLabelText('URL do documento'), {
          target: { value: 'https://example.com/openapi.json' },
        })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar' }))

        const alert = await within(dialog).findByRole('alert')
        expect(alert).toHaveTextContent('falha ao buscar URL')
        expect(importModal()).toBeInTheDocument()
      })

      it('destaca a drop zone durante o arraste e importa todos os arquivos soltos', async () => {
        let dropHandler: (event: { type: string; paths?: string[] }) => void = () => {}
        onFileDrop.mockImplementation(async (handler: typeof dropHandler) => {
          dropHandler = handler
          return () => {}
        })
        pickImportFiles.mockResolvedValue([])
        importCollections.mockResolvedValue({
          ok: true,
          value: { collections: [{ id: 'imported-1', name: 'Dropped API', folders: [], requests: [] }], environments: [] },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        openImportModal()
        await vi.waitFor(() => expect(onFileDrop).toHaveBeenCalled())

        dropHandler({ type: 'over' })
        await vi.waitFor(() => expect(document.querySelector('.import-modal-dropzone--over')).toBeInTheDocument())

        dropHandler({ type: 'drop', paths: ['/dropped/a.json', '/dropped/b.json'] })
        await confirmImportReview()

        expect(await within(collectionsSidebar()).findByText('Dropped API')).toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Dropped API 2')).toBeInTheDocument()
        expect(importCollections).toHaveBeenNthCalledWith(1, '/dropped/a.json', '/workspace')
        expect(importCollections).toHaveBeenNthCalledWith(2, '/dropped/b.json', '/workspace')
      })
    })

    describe('importar arrastando para a janela', () => {
      const imageCollection = {
        id: 'shared-collection',
        name: 'Listar usuários',
        folders: [],
        authentication: { type: 'none' },
        requests: [
          {
            id: 'shared-request',
            name: 'Listar usuários',
            protocol: 'rest',
            endpoint: 'https://api.test/users',
            method: 'get',
            body: '',
            restBody: { type: 'none' },
            variables: '',
            headers: [],
            authentication: { type: 'none' },
            preRequestScript: '',
            postResponseScript: '',
          },
        ],
      }

      it('ao soltar um PNG na janela, abre a requisição como rascunho sem criar collection', async () => {
        let dropHandler: (event: { type: string; paths?: string[] }) => void = () => {}
        onFileDrop.mockImplementation(async (handler: typeof dropHandler) => {
          dropHandler = handler
          return () => {}
        })
        importCollections.mockResolvedValue({ ok: true, value: { collections: [imageCollection], environments: [] } })

        render()
        await screen.findByLabelText('Ambiente')
        await vi.waitFor(() => expect(onFileDrop).toHaveBeenCalled())

        act(() => dropHandler({ type: 'enter', paths: ['/tmp/listar.png'] }))
        expect(screen.getByRole('status')).toHaveTextContent('Solte para importar')
        act(() => dropHandler({ type: 'drop', paths: ['/tmp/listar.png'] }))

        const openTabsBar = () => screen.getByRole('tablist', { name: 'Requisições abertas' })
        expect(await within(openTabsBar()).findByRole('tab', { name: /Listar usuários/ })).toHaveAttribute('aria-selected', 'true')
        expect(importCollections).toHaveBeenCalledWith('/tmp/listar.png', '/workspace')
        openCollectionsTab()
        expect(within(collectionsSidebar()).queryByText('Listar usuários')).not.toBeInTheDocument()
      })

      it('ao soltar um arquivo de texto com curl, importa sem abrir a modal', async () => {
        let dropHandler: (event: { type: string; paths?: string[] }) => void = () => {}
        onFileDrop.mockImplementation(async (handler: typeof dropHandler) => {
          dropHandler = handler
          return () => {}
        })
        importCollections.mockResolvedValue({
          ok: true,
          value: { collections: [{ id: 'imported-1', name: 'Curl API', folders: [], requests: [] }], environments: [] },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await vi.waitFor(() => expect(onFileDrop).toHaveBeenCalled())

        act(() => dropHandler({ type: 'enter', paths: ['/tmp/login.sh'] }))
        expect(screen.getByRole('status')).toHaveTextContent('Solte para importar')
        act(() => dropHandler({ type: 'drop', paths: ['/tmp/login.sh'] }))

        expect(await within(collectionsSidebar()).findByText('Curl API')).toBeInTheDocument()
        expect(importCollections).toHaveBeenCalledWith('/tmp/login.sh', '/workspace')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })

      it('ao soltar uma pasta, importa cada arquivo importável sem abrir a modal', async () => {
        let dropHandler: (event: { type: string; paths?: string[] }) => void = () => {}
        onFileDrop.mockImplementation(async (handler: typeof dropHandler) => {
          dropHandler = handler
          return () => {}
        })
        expandImportPaths.mockResolvedValueOnce({ ok: true, value: ['/tmp/pasta/a.json', '/tmp/pasta/b.txt'] })
        importCollections.mockResolvedValue({
          ok: true,
          value: { collections: [{ id: 'imported-1', name: 'Pasta API', folders: [], requests: [] }], environments: [] },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await vi.waitFor(() => expect(onFileDrop).toHaveBeenCalled())

        act(() => dropHandler({ type: 'drop', paths: ['/tmp/pasta'] }))

        expect(await within(collectionsSidebar()).findByText('Pasta API')).toBeInTheDocument()
        expect(expandImportPaths).toHaveBeenCalledWith(['/tmp/pasta'])
        expect(importCollections).toHaveBeenNthCalledWith(1, '/tmp/pasta/a.json', '/workspace')
        expect(importCollections).toHaveBeenNthCalledWith(2, '/tmp/pasta/b.txt', '/workspace')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
    })

    describe('adicionar requisição', () => {
      const createCollection = () => {
        fireEvent.click(addRequestButton())
        fireEvent.click(screen.getByRole('option', { name: 'Criar Collection' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      }

      it('abre o popover de tipos com HTTP, GraphQL, gRPC e WebSocket, filtrando pela busca', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar requisição' }))

        const types = screen.getByRole('listbox', { name: 'Tipos de requisição' })
        expect(within(types).getAllByRole('option').map((option) => option.textContent)).toEqual(['HTTPHTTP', 'GQLGraphQL', 'gRPCgRPC', 'WSWebSocket'])
        expect(screen.getByLabelText('Buscar tipo de requisição')).toHaveFocus()

        fireEvent.change(screen.getByLabelText('Buscar tipo de requisição'), { target: { value: 'graph' } })
        expect(within(types).getAllByRole('option')).toHaveLength(1)
        expect(within(types).getByRole('option', { name: 'GraphQL' })).toBeInTheDocument()

        fireEvent.change(screen.getByLabelText('Buscar tipo de requisição'), { target: { value: 'grpc' } })
        expect(within(types).getAllByRole('option')).toHaveLength(1)
        expect(within(types).getByRole('option', { name: 'gRPC' })).toBeInTheDocument()

        fireEvent.change(screen.getByLabelText('Buscar tipo de requisição'), { target: { value: 'soap' } })
        expect(within(types).queryAllByRole('option')).toHaveLength(0)
        expect(screen.getByText('Nenhum tipo encontrado.')).toBeInTheDocument()
      })

      it('cria uma requisição HTTP pela pasta já salva com o nome padrão, abrindo uma aba REST em branco (método GET)', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar requisição' }))
        fireEvent.click(screen.getByRole('option', { name: 'HTTP' }))

        expect(screen.queryByRole('listbox', { name: 'Tipos de requisição' })).not.toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(
          within(collectionsSidebar()).getByText('Nova requisição').closest('.collections-row'),
        ).toHaveTextContent('GET')
        expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toHaveValue('get')
        expect(screen.getByRole('tab', { name: 'Body' })).toBeInTheDocument()
        expect(screen.queryByRole('tab', { name: 'Query' })).not.toBeInTheDocument()
        expect(screen.getByLabelText('Endpoint')).toHaveValue('')
      })

      it('cria uma requisição GraphQL pela pasta com o teclado e a lista na árvore', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar requisição' }))
        const search = screen.getByLabelText('Buscar tipo de requisição')
        fireEvent.keyDown(search, { key: 'ArrowDown' })
        fireEvent.keyDown(search, { key: 'Enter' })

        expect(
          within(collectionsSidebar()).getByText('Nova requisição').closest('.collections-row'),
        ).toHaveTextContent('GQL')
        expect(screen.getByLabelText('Endpoint')).toHaveValue('')
      })

      it('fecha o popover com Escape ou clicando fora sem criar a requisição', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar requisição' }))
        fireEvent.keyDown(screen.getByLabelText('Buscar tipo de requisição'), { key: 'Escape' })
        expect(screen.queryByRole('listbox', { name: 'Tipos de requisição' })).not.toBeInTheDocument()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar requisição' }))
        fireEvent.pointerDown(document.body)
        expect(screen.queryByRole('listbox', { name: 'Tipos de requisição' })).not.toBeInTheDocument()

        expect(within(collectionsSidebar()).queryByText('Nova requisição')).not.toBeInTheDocument()
      })

      it('permite duas requisições com o mesmo nome no mesmo nível', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Nova requisição')
        addRequestTo('Nova Collection', 'Nova requisição')

        expect(within(collectionsSidebar()).getAllByText('Nova requisição')).toHaveLength(2)
        expect(within(collectionsSidebar()).queryByText('Nova requisição 2')).not.toBeInTheDocument()
      })

      it('renomeia uma requisição com o mesmo nome de uma irmã sem sufixo', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Ping')
        addRequestTo('Nova Collection', 'Health check')

        openMenu('Health check')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
        const nameInput = within(collectionsSidebar()).getByLabelText('Nome')
        fireEvent.change(nameInput, { target: { value: 'Ping' } })
        fireEvent.keyDown(nameInput, { key: 'Enter' })

        expect(within(collectionsSidebar()).getAllByText('Ping')).toHaveLength(2)
        expect(within(collectionsSidebar()).queryByText('Health check')).not.toBeInTheDocument()
      })

      it('renomeia e remove uma requisição pelo próprio menu "⋯"', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Ping')

        openMenu('Ping')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
        const nameInput = within(collectionsSidebar()).getByLabelText('Nome')
        fireEvent.change(nameInput, { target: { value: 'Health check' } })
        fireEvent.keyDown(nameInput, { key: 'Enter' })

        expect(within(collectionsSidebar()).getByText('Health check')).toBeInTheDocument()

        openMenu('Health check')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Remover' }))

        const dialog = screen.getByRole('dialog', { name: 'Remover requisição?' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }))

        expect(within(collectionsSidebar()).queryByText('Health check')).not.toBeInTheDocument()
      })

      it('o "+" da barra de abas abre o popover e cria um rascunho avulso "Nova requisição" do tipo escolhido', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        const tabsBar = () => screen.getByRole('tablist', { name: 'Requisições abertas' })
        const tabCountBefore = within(tabsBar()).getAllByRole('tab').length

        createRequestFromTabsBar('REST')

        expect(screen.queryByRole('listbox', { name: 'Tipos de requisição' })).not.toBeInTheDocument()
        const tabs = within(tabsBar()).getAllByRole('tab')
        expect(tabs).toHaveLength(tabCountBefore + 1)
        expect(tabs.at(-1)).toHaveAccessibleName('Nova requisição')
        expect(tabs.at(-1)).toHaveTextContent('GETNova requisição')
        expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toHaveValue('get')
        expect(screen.getByRole('tab', { name: 'Body' })).toBeInTheDocument()
        expect(screen.queryByRole('tab', { name: 'Query' })).not.toBeInTheDocument()
        expect(within(collectionsSidebar()).queryByText('Nova requisição')).not.toBeInTheDocument()
      })

      it('regressão: o pointerdown de um clique real num item do menu "..." não fecha o menu antes do click chegar a ele', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        createCollection()

        openMoreMenu()
        const menuItem = within(collectionsSidebar()).getByRole('menuitem', { name: 'Exportar tudo' })
        // Real clicks dispatch pointerdown first, invoking the outside-menu listener unlike an isolated fireEvent.click.
        fireEvent.pointerDown(menuItem)
        fireEvent.click(menuItem)

        expect(pickExportFile).toHaveBeenCalledWith('workspace')
      })

      it('o "+" da sidebar abre o popover e cria um rascunho avulso mesmo sem nenhuma Collection existente', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()

        expect(within(collectionsSidebar()).getByText('Nenhuma Collection ainda.')).toBeInTheDocument()

        fireEvent.click(addRequestButton())
        fireEvent.click(screen.getByRole('option', { name: 'GraphQL' }))

        expect(screen.getByRole('tab', { name: 'Nova requisição' })).toHaveTextContent('GQLNova requisição')
        expect(within(collectionsSidebar()).getByText('Nenhuma Collection ainda.')).toBeInTheDocument()
      })
    })

    describe('duplicar e mover requisições', () => {
      const createCollection = () => {
        fireEvent.click(addRequestButton())
        fireEvent.click(screen.getByRole('option', { name: 'Criar Collection' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      }

      const addRequestNamed = (name: string) => addRequestTo('Nova Collection', name)

      it('duplica uma requisição pelo menu com nome deduplicado e já a abre no editor', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        addRequestNamed('Ping')

        openMenu('Ping')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar' }))

        expect(within(collectionsSidebar()).getByText('Ping')).toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Ping cópia')).toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Ping cópia')).toHaveAttribute(
          'aria-current',
          'true',
        )
      })

      it('move uma requisição para outra Collection pela modal', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        createCollection()
        addRequestNamed('Ping')

        openMenu('Ping')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para...' }))

        const dialog = screen.getByRole('dialog', { name: 'Mover requisição' })
        expect(within(dialog).getByText('Selecione uma collection')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Mover' })).toBeDisabled()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Nova Collection 2' }))
        expect(within(dialog).getByText('Nova Collection 2', { selector: '.destination-browser-breadcrumb' })).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Ping')).toBeInTheDocument()

        fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: 'Recolher Nova Collection 2' }))
        expect(within(collectionsSidebar()).queryByText('Ping')).not.toBeInTheDocument()
      })

      it('destaca o alvo e mostra um rótulo flutuante enquanto arrasta uma requisição', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        createCollection()
        addRequestNamed('Ping')

        const requestRow = within(collectionsSidebar())
          .getByText('Ping')
          .closest('.collections-row')!
        const targetRow = within(collectionsSidebar()).getByText('Nova Collection 2').closest('.collections-row')!

        const originalElementFromPoint = document.elementFromPoint
        document.elementFromPoint = () => targetRow

        expect(targetRow).not.toHaveClass('collections-row--drop-into')

        fireEvent.pointerDown(requestRow, { button: 0, clientX: 0, clientY: 0 })
        fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })

        expect(targetRow).toHaveClass('collections-row--drop-into')
        expect(document.querySelector('.drag-preview')).toHaveTextContent('Ping')

        fireEvent.pointerUp(window)
        document.elementFromPoint = originalElementFromPoint

        expect(document.querySelector('.drag-preview')).not.toBeInTheDocument()
        expect(targetRow).not.toHaveClass('collections-row--drop-into')
      })

      it('move uma requisição arrastando com o mouse para outra Collection', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        createCollection()
        addRequestNamed('Ping')

        const requestRow = within(collectionsSidebar())
          .getByText('Ping')
          .closest('.collections-row')!
        const targetRow = within(collectionsSidebar()).getByText('Nova Collection 2').closest('.collections-row')!

        dragOnto(requestRow, targetRow)

        expect(within(collectionsSidebar()).getByText('Ping')).toBeInTheDocument()

        fireEvent.click(within(collectionsSidebar()).getByRole('button', { name: 'Recolher Nova Collection 2' }))
        expect(within(collectionsSidebar()).queryByText('Ping')).not.toBeInTheDocument()
      })

      it('reordena duas requisições dentro da mesma pasta arrastando uma sobre a outra', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')
        addRequestNamed('Request B')

        const orderedNames = () =>
          within(collectionsSidebar())
            .getAllByText(/^Request/)
            .map((button) => button.textContent)

        expect(orderedNames()).toEqual(['Request A', 'Request B'])

        const draggedRow = within(collectionsSidebar())
          .getByText('Request B')
          .closest('.collections-row')!
        const targetRow = within(collectionsSidebar())
          .getByText('Request A')
          .closest('.collections-row')!

        dragOnto(draggedRow, targetRow)

        expect(orderedNames()).toEqual(['Request B', 'Request A'])
      })

      it('mostra uma borda indicando o lado em que a requisição arrastada entraria, e reordena depois do alvo ao soltar na metade de baixo', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')
        addRequestNamed('Request B')

        const orderedNames = () =>
          within(collectionsSidebar())
            .getAllByText(/^Request/)
            .map((button) => button.textContent)

        const draggedRow = within(collectionsSidebar())
          .getByText('Request B')
          .closest('.collections-row')!
        const targetRow = within(collectionsSidebar())
          .getByText('Request A')
          .closest('.collections-row')!

        const originalElementFromPoint = document.elementFromPoint
        document.elementFromPoint = () => targetRow
        const originalRect = targetRow.getBoundingClientRect
        targetRow.getBoundingClientRect = () =>
          ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => {} }) as DOMRect

        fireEvent.pointerDown(draggedRow, { button: 0, clientX: 0, clientY: 0 })
        fireEvent.pointerMove(window, { clientX: 90, clientY: 90 })

        expect(targetRow).toHaveClass('collections-row--drop-after')
        expect(targetRow).not.toHaveClass('collections-row--drop-before')
        expect(targetRow).not.toHaveClass('collections-row--drop-into')

        fireEvent.pointerUp(window)
        document.elementFromPoint = originalElementFromPoint
        targetRow.getBoundingClientRect = originalRect

        expect(orderedNames()).toEqual(['Request A', 'Request B'])
      })

      it('move uma pasta para dentro de outra Collection arrastando com o mouse', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        createCollection()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        const folderRow = within(collectionsSidebar()).getByText('Nova pasta').closest('.collections-row')!
        const targetRow = within(collectionsSidebar()).getByText('Nova Collection 2').closest('.collections-row')!

        dragOnto(folderRow, targetRow)

        expect(within(collectionsSidebar()).getByText('Nova pasta')).toBeInTheDocument()
        expect(
          within(collectionsSidebar()).queryByRole('button', { name: 'Expandir Nova Collection' }),
        ).not.toBeInTheDocument()
      })

      it('reordena duas pastas irmãs arrastando uma sobre a borda da outra', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        const folderNames = () =>
          within(collectionsSidebar())
            .getAllByText(/^Nova pasta/)
            .map((el) => el.textContent)

        expect(folderNames()).toEqual(['Nova pasta', 'Nova pasta 2'])

        const draggedRow = within(collectionsSidebar()).getByText('Nova pasta 2').closest('.collections-row')!
        const targetRow = within(collectionsSidebar()).getByText('Nova pasta').closest('.collections-row')!

        dragOnto(draggedRow, targetRow, 'before')

        expect(folderNames()).toEqual(['Nova pasta 2', 'Nova pasta'])
      })

      it('mostra a borda antes/depois ao pairar sobre a ponta de uma pasta, e destaque cheio ao pairar sobre o meio', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })

        const draggedRow = within(collectionsSidebar()).getByText('Nova pasta 2').closest('.collections-row')!
        const targetRow = within(collectionsSidebar()).getByText('Nova pasta').closest('.collections-row')!

        const originalElementFromPoint = document.elementFromPoint
        document.elementFromPoint = () => targetRow
        const originalRect = targetRow.getBoundingClientRect
        targetRow.getBoundingClientRect = () =>
          ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => {} }) as DOMRect

        fireEvent.pointerDown(draggedRow, { button: 0, clientX: 0, clientY: 0 })

        fireEvent.pointerMove(window, { clientX: 10, clientY: 10 })
        expect(targetRow).toHaveClass('collections-row--drop-before')
        expect(targetRow).not.toHaveClass('collections-row--drop-into')

        fireEvent.pointerMove(window, { clientX: 50, clientY: 50 })
        expect(targetRow).toHaveClass('collections-row--drop-into')
        expect(targetRow).not.toHaveClass('collections-row--drop-before')
        expect(targetRow).not.toHaveClass('collections-row--drop-after')

        fireEvent.pointerUp(window)
        document.elementFromPoint = originalElementFromPoint
        targetRow.getBoundingClientRect = originalRect
      })

      it('reordena Collections arrastando uma sobre a outra', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        createCollection()

        const collectionNames = () =>
          within(collectionsSidebar())
            .getAllByText(/^Nova Collection/)
            .map((element) => element.textContent)

        expect(collectionNames()).toEqual(['Nova Collection', 'Nova Collection 2'])

        const draggedRow = within(collectionsSidebar()).getByText('Nova Collection 2').closest('.collections-row')!
        const targetRow = within(collectionsSidebar()).getByText('Nova Collection').closest('.collections-row')!

        dragOnto(draggedRow, targetRow)

        expect(collectionNames()).toEqual(['Nova Collection 2', 'Nova Collection'])
      })
    })

    describe('abas de requisições abertas', () => {
      const createCollection = () => {
        fireEvent.click(addRequestButton())
        fireEvent.click(screen.getByRole('option', { name: 'Criar Collection' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      }

      const addRequestNamed = (name: string) => addRequestTo('Nova Collection', name)

      const openTabsBar = () => screen.getByRole('tablist', { name: 'Requisições abertas' })

      it('fixa uma aba de visualização ao editar e isola seu conteúdo das outras abas', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')
        pasteIntoQueryEditor('query { a }')

        expect(
          within(openTabsBar()).getByRole('tab', { name: 'Request A' }).closest('.rw-open-tab'),
        ).not.toHaveClass('rw-open-tab--preview')

        addRequestNamed('Request B')
        expect(queryEditorText()).toBe('')

        fireEvent.click(within(openTabsBar()).getByRole('tab', { name: 'Request A' }))
        expect(queryEditorText()).toBe('query { a }')
      })

      it('mostra requisições limpas em itálico e substitui a visualização ao abrir outra', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')

        expect(
          within(openTabsBar()).getByRole('tab', { name: 'Request A' }).closest('.rw-open-tab'),
        ).toHaveClass('rw-open-tab--preview')

        addRequestNamed('Request B')

        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(1)
        expect(within(openTabsBar()).queryByRole('tab', { name: 'Request A' })).not.toBeInTheDocument()
        expect(
          within(openTabsBar()).getByRole('tab', { name: 'Request B' }).closest('.rw-open-tab'),
        ).toHaveClass('rw-open-tab--preview')
      })

      it('fixa a aba de visualização com duplo clique antes de abrir outra requisição', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')

        const requestATab = within(openTabsBar()).getByRole('tab', { name: 'Request A' })
        fireEvent.doubleClick(requestATab)

        expect(requestATab.closest('.rw-open-tab')).not.toHaveClass('rw-open-tab--preview')

        addRequestNamed('Request B')

        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(2)
        expect(within(openTabsBar()).getByRole('tab', { name: 'Request A' })).toBeInTheDocument()
        expect(within(openTabsBar()).getByRole('tab', { name: 'Request B' })).toBeInTheDocument()
      })

      it('fixa a aba de visualização com duplo clique na requisição em Collections', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')

        const requestATab = within(openTabsBar()).getByRole('tab', { name: 'Request A' })
        expect(requestATab.closest('.rw-open-tab')).toHaveClass('rw-open-tab--preview')

        fireEvent.doubleClick(within(collectionsSidebar()).getByText('Request A'))

        expect(requestATab.closest('.rw-open-tab')).not.toHaveClass('rw-open-tab--preview')

        addRequestNamed('Request B')

        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(2)
      })

      it('fixa a aba de visualização ao enviar antes de abrir outra requisição', async () => {
        executeGraphqlRequest.mockImplementation(() => new Promise(() => {}))

        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')

        const requestATab = within(openTabsBar()).getByRole('tab', { name: 'Request A' })
        expect(requestATab.closest('.rw-open-tab')).toHaveClass('rw-open-tab--preview')

        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        await waitFor(() => expect(requestATab.closest('.rw-open-tab')).not.toHaveClass('rw-open-tab--preview'))

        addRequestNamed('Request B')

        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(2)
        expect(within(openTabsBar()).getByRole('tab', { name: 'Request A' })).toBeInTheDocument()
        expect(within(openTabsBar()).getByRole('tab', { name: 'Request B' })).toBeInTheDocument()
      })

      it('usa a mesma pré-visualização ao alternar entre eventos de requisição e Flow do histórico', async () => {
        listHistory.mockResolvedValue({
          ok: true,
          value: [
            {
              origin: 'collection',
              id: 'history-request-1',
              protocol: 'graphql',
              endpoint: 'https://api.example.com/graphql',
              executedAtMs: Date.now(),
              outcome: { type: 'success', statusCode: 200, durationMs: 12, sizeBytes: 2, responseStored: true },
            },
            {
              origin: 'flow',
              id: 'history-flow-1',
              flowName: 'Smoke test',
              executedAtMs: Date.now() - 1_000,
              durationMs: 20,
              status: 'completed',
            },
          ],
        })
        getHistoryEntry.mockResolvedValue({
          ok: true,
          value: {
            id: 'history-request-1',
            protocol: 'graphql',
            endpoint: 'https://api.example.com/graphql',
            method: 'post',
            body: 'query { ping }',
            variables: '{}',
            headers: [],
            authentication: { type: 'none' },
            executedAtMs: Date.now(),
            outcome: {
              type: 'success',
              statusCode: 200,
              durationMs: 12,
              sizeBytes: 2,
              body: { kind: 'inline', body: '{}' },
              bodyEncoding: 'text',
              headers: [],
              graphqlErrors: [],
            },
          },
        })
        getFlowRunHistory.mockResolvedValue({
          ok: true,
          value: {
            id: 'history-flow-1',
            flowName: 'Smoke test',
            startedAtMs: Date.now() - 20,
            finishedAtMs: Date.now(),
            cancelled: false,
            nodes: [],
            edges: [],
            events: [],
            outputs: [],
          },
        })

        render()
        await screen.findByLabelText('Ambiente')
        fireEvent.click(screen.getByRole('tab', { name: 'Histórico' }))

        fireEvent.click(
          await screen.findByRole('button', { name: 'Restaurar requisição de https://api.example.com/graphql' }),
        )
        const requestTab = await within(openTabsBar()).findByRole('tab', {
          name: 'https://api.example.com/graphql',
        })
        expect(requestTab.closest('.rw-open-tab')).toHaveClass('rw-open-tab--preview')

        fireEvent.click(screen.getByRole('button', { name: 'Abrir snapshot de Smoke test' }))
        const flowTab = await within(openTabsBar()).findByRole('tab', { name: 'Smoke test' })

        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(1)
        expect(within(openTabsBar()).queryByRole('tab', { name: 'https://api.example.com/graphql' })).not.toBeInTheDocument()
        expect(flowTab.closest('.rw-open-tab')).toHaveClass('rw-open-tab--preview')

        fireEvent.doubleClick(flowTab)
        expect(flowTab.closest('.rw-open-tab')).not.toHaveClass('rw-open-tab--preview')

        fireEvent.click(
          screen.getByRole('button', { name: 'Restaurar requisição de https://api.example.com/graphql' }),
        )

        expect(
          await within(openTabsBar()).findByRole('tab', { name: 'https://api.example.com/graphql', selected: true }),
        ).toBeInTheDocument()
        expect(within(openTabsBar()).getByRole('tab', { name: 'Smoke test' })).toBeInTheDocument()
        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(2)
      })

      it('reabrir uma requisição já aberta troca de aba em vez de abrir outra', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')

        fireEvent.click(within(collectionsSidebar()).getByText('Request A'))

        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(1)
        expect(within(openTabsBar()).getByRole('tab', { name: 'Request A', selected: true })).toBeInTheDocument()
      })

      it('arrasta uma aba com o mouse para reordenar a lista de abas abertas', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')
        fireEvent.doubleClick(within(openTabsBar()).getByRole('tab', { name: 'Request A' }))
        addRequestNamed('Request B')
        fireEvent.doubleClick(within(openTabsBar()).getByRole('tab', { name: 'Request B' }))
        addRequestNamed('Request C')

        const orderedLabels = () => within(openTabsBar()).getAllByRole('tab').map((tab) => tab.querySelector('.rw-open-tab-name')?.textContent)
        expect(orderedLabels()).toEqual(['Request A', 'Request B', 'Request C'])

        const draggedTab = within(openTabsBar()).getByRole('tab', { name: 'Request C' }).closest('.rw-open-tab')!
        const targetTab = within(openTabsBar()).getByRole('tab', { name: 'Request A' }).closest('.rw-open-tab')!

        dragOnto(draggedTab, targetTab)

        expect(orderedLabels()).toEqual(['Request C', 'Request A', 'Request B'])
      })

      it('mostra uma borda indicando o lado em que a aba arrastada entraria, e reordena depois do alvo ao soltar na metade direita', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')
        fireEvent.doubleClick(within(openTabsBar()).getByRole('tab', { name: 'Request A' }))
        addRequestNamed('Request B')
        fireEvent.doubleClick(within(openTabsBar()).getByRole('tab', { name: 'Request B' }))
        addRequestNamed('Request C')

        const orderedLabels = () => within(openTabsBar()).getAllByRole('tab').map((tab) => tab.querySelector('.rw-open-tab-name')?.textContent)

        const draggedTab = within(openTabsBar()).getByRole('tab', { name: 'Request C' }).closest('.rw-open-tab')!
        const targetTab = within(openTabsBar()).getByRole('tab', { name: 'Request A' }).closest('.rw-open-tab')!

        dragOnto(draggedTab, targetTab, 'after')

        expect(orderedLabels()).toEqual(['Request A', 'Request C', 'Request B'])
      })

      it('o botão "+" abre uma nova aba em branco e cada aba pode ser fechada individualmente', async () => {
        render()
        await screen.findByLabelText('Ambiente')

        expect(within(openTabsBar()).queryAllByRole('tab')).toHaveLength(0)

        createRequestFromTabsBar('GraphQL')
        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(1)

        openCollectionsTab()
        createCollection()
        addRequestNamed('Ping')
        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(2)

        fireEvent.click(within(openTabsBar()).getByRole('button', { name: 'Fechar aba Ping' }))
        expect(within(openTabsBar()).getAllByRole('tab')).toHaveLength(1)
        expect(within(openTabsBar()).queryByRole('tab', { name: 'Ping' })).not.toBeInTheDocument()
      })

      it('fechar a última aba aberta mostra a tela de descanso', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        createRequestFromTabsBar('GraphQL')

        expect(queryEditorText()).toBe('')

        fireEvent.click(within(openTabsBar()).getByRole('button', { name: 'Fechar aba Nova requisição' }))
        const dialog = screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Descartar' }))

        expect(within(openTabsBar()).queryAllByRole('tab')).toHaveLength(0)
        expect(screen.getByRole('button', { name: 'Nova requisição GraphQL' })).toBeInTheDocument()
        expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument()
      })

      it('fechar uma aba com alterações não salvas pede confirmação; cancelar mantém a aba aberta', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Ping')

        pasteIntoQueryEditor('query { ping }')

        fireEvent.click(within(openTabsBar()).getByRole('button', { name: 'Fechar aba Ping' }))
        const dialog = screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))

        expect(within(openTabsBar()).getByRole('tab', { name: 'Ping' })).toBeInTheDocument()
        expect(queryEditorText()).toBe('query { ping }')

        fireEvent.click(within(openTabsBar()).getByRole('button', { name: 'Fechar aba Ping' }))
        fireEvent.click(
          within(screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })).getByRole('button', {
            name: 'Descartar',
          }),
        )

        expect(within(openTabsBar()).queryByRole('tab', { name: 'Ping' })).not.toBeInTheDocument()
      })

      it('libera o corpo de resposta em cache ao fechar uma aba com um resultado windowed', async () => {
        executeGraphqlRequest.mockResolvedValue({
          ok: true,
          value: {
            statusCode: 200,
            durationMs: 5,
            sizeBytes: 999,
            body: { kind: 'windowed', handle: 'exec-large', totalBytes: 999, preview: 'a', previewNextOffset: 40 },
            bodyEncoding: 'text',
            requestHeaders: [],
            cookies: [],
            connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
            finalUrl: null,
            waitingMs: 0,
            environmentChanges: [],
            scriptLogs: [],
            scriptError: null,
            headers: [],
            graphqlErrors: [],
          },
        })

        render()
        await screen.findByLabelText('Ambiente')
        createRequestFromTabsBar('GraphQL')
        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        await findStatusText(/200/)

        fireEvent.click(within(openTabsBar()).getByRole('button', { name: 'Fechar aba Nova requisição' }))
        const dialog = screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Descartar' }))

        expect(releaseResponseBody).toHaveBeenCalledWith('exec-large')
      })

      it('cancelar o fechamento de uma aba com um resultado windowed não libera o corpo em cache', async () => {
        executeGraphqlRequest.mockResolvedValue({
          ok: true,
          value: {
            statusCode: 200,
            durationMs: 5,
            sizeBytes: 999,
            body: { kind: 'windowed', handle: 'exec-large', totalBytes: 999, preview: 'a', previewNextOffset: 40 },
            bodyEncoding: 'text',
            requestHeaders: [],
            cookies: [],
            connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
            finalUrl: null,
            waitingMs: 0,
            environmentChanges: [],
            scriptLogs: [],
            scriptError: null,
            headers: [],
            graphqlErrors: [],
          },
        })

        render()
        await screen.findByLabelText('Ambiente')
        createRequestFromTabsBar('GraphQL')
        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        await findStatusText(/200/)

        fireEvent.click(within(openTabsBar()).getByRole('button', { name: 'Fechar aba Nova requisição' }))
        const dialog = screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))

        expect(releaseResponseBody).not.toHaveBeenCalled()
      })

      it('libera o resultado windowed anterior ao reenviar a mesma aba', async () => {
        executeGraphqlRequest.mockResolvedValueOnce({
          ok: true,
          value: {
            statusCode: 200,
            durationMs: 5,
            sizeBytes: 999,
            body: { kind: 'windowed', handle: 'exec-1', totalBytes: 999, preview: 'a', previewNextOffset: 40 },
            bodyEncoding: 'text',
            requestHeaders: [],
            cookies: [],
            connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
            finalUrl: null,
            waitingMs: 0,
            environmentChanges: [],
            scriptLogs: [],
            scriptError: null,
            headers: [],
            graphqlErrors: [],
          },
        })

        render()
        await screen.findByLabelText('Ambiente')
        createRequestFromTabsBar('GraphQL')
        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        await findStatusText(/200/)

        executeGraphqlRequest.mockResolvedValueOnce({
          ok: true,
          value: { statusCode: 200, durationMs: 5, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

        expect(releaseResponseBody).toHaveBeenCalledWith('exec-1')
      })

      it('não libera nada ao fechar ou reenviar uma aba sem resultado windowed', async () => {
        executeGraphqlRequest.mockResolvedValue({
          ok: true,
          value: { statusCode: 200, durationMs: 5, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
        })

        render()
        await screen.findByLabelText('Ambiente')
        createRequestFromTabsBar('GraphQL')
        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        await findStatusText(/200/)

        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        expect(releaseResponseBody).not.toHaveBeenCalled()

        fireEvent.click(within(openTabsBar()).getByRole('button', { name: 'Fechar aba Nova requisição' }))
        fireEvent.click(
          within(screen.getByRole('dialog', { name: 'Descartar alterações não salvas?' })).getByRole('button', {
            name: 'Descartar',
          }),
        )

        expect(releaseResponseBody).not.toHaveBeenCalled()
      })

      it('renomear uma requisição aberta pela árvore atualiza o título da sua aba', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Ping')

        expect(within(openTabsBar()).getByRole('tab', { name: 'Ping' })).toBeInTheDocument()

        openMenu('Ping')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
        const nameInput = within(collectionsSidebar()).getByLabelText('Nome')
        fireEvent.change(nameInput, { target: { value: 'Health check' } })
        fireEvent.keyDown(nameInput, { key: 'Enter' })

        expect(within(openTabsBar()).getByRole('tab', { name: 'Health check' })).toBeInTheDocument()
        expect(within(openTabsBar()).queryByRole('tab', { name: 'Ping' })).not.toBeInTheDocument()
      })

      it('reabrir o mesmo workspace restaura as abas que estavam abertas', async () => {
        listCollections.mockResolvedValue({
          ok: true,
          value: [
            {
              id: 'collection-1',
              name: 'Customer API',
              folders: [],
              authentication: { type: 'inherit' },
              requests: [
                {
                  id: 'request-1',
                  name: 'Ping',
                  protocol: 'graphql',
                  endpoint: 'https://api.example.com/graphql',
                  body: 'query { ping }',
                  variables: '{}',
                  headers: [],
                  authentication: { type: 'none' },
                },
              ],
            },
          ],
        })

        const firstOpen = render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        fireEvent.click(await within(collectionsSidebar()).findByRole('button', { name: 'Expandir Customer API' }))
        fireEvent.click(within(collectionsSidebar()).getByText('Ping'))
        expect(within(openTabsBar()).getByRole('tab', { name: 'Ping' })).toBeInTheDocument()

        firstOpen.unmount()

        render()
        await screen.findByLabelText('Ambiente')

        expect(await within(openTabsBar()).findByRole('tab', { name: 'Ping', selected: true })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Nova requisição GraphQL' })).not.toBeInTheDocument()
        expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.example.com/graphql')
      })

      it('um workspace nunca aberto antes começa na tela de descanso, mesmo com Collections salvas', async () => {
        listCollections.mockResolvedValue({
          ok: true,
          value: [{ id: 'collection-1', name: 'Customer API', folders: [], requests: [] }],
        })

        render()
        await screen.findByLabelText('Ambiente')

        expect(await screen.findByRole('button', { name: 'Nova requisição GraphQL' })).toBeInTheDocument()
        expect(within(openTabsBar()).queryAllByRole('tab')).toHaveLength(0)
      })

      it('não mostra a tela de descanso enquanto as abas persistidas ainda estão sendo restauradas', async () => {
        const collectionsWithPing = {
          ok: true,
          value: [
            {
              id: 'collection-1',
              name: 'Customer API',
              folders: [],
              authentication: { type: 'inherit' },
              requests: [
                {
                  id: 'request-1',
                  name: 'Ping',
                  protocol: 'graphql',
                  endpoint: 'https://api.example.com/graphql',
                  body: 'query { ping }',
                  variables: '{}',
                  headers: [],
                  authentication: { type: 'none' },
                },
              ],
            },
          ],
        }
        window.localStorage.setItem(
          'alcy:workbench-tabs:/workspace',
          JSON.stringify({ openRequestIds: ['request-1'], activeRequestId: 'request-1' }),
        )
        let resolveCollections: (value: unknown) => void = () => {}
        listCollections.mockImplementation(() => new Promise((resolve) => { resolveCollections = resolve }))

        render()
        expect(await screen.findByRole('status')).toHaveTextContent('Carregando workspace Workspace…')

        expect(screen.queryByRole('button', { name: 'Nova requisição GraphQL' })).not.toBeInTheDocument()

        await act(async () => resolveCollections(collectionsWithPing))

        await screen.findByLabelText('Ambiente')
        expect(await within(openTabsBar()).findByRole('tab', { name: 'Ping', selected: true })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Nova requisição GraphQL' })).not.toBeInTheDocument()
      })

      it('resolve variáveis da coleção e da pasta na requisição e as envia em camadas', async () => {
        listCollections.mockResolvedValue({
          ok: true,
          value: [
            {
              id: 'collection-1',
              name: 'Customer API',
              authentication: { type: 'inherit' },
              variables: [{ name: 'baseUrl', value: 'https://collection.example.com' }],
              requests: [],
              folders: [
                {
                  id: 'folder-1',
                  name: 'Pedidos',
                  authentication: { type: 'inherit' },
                  variables: [{ name: 'orderId', value: '42' }],
                  folders: [],
                  requests: [
                    {
                      id: 'request-1',
                      name: 'Pedido',
                      protocol: 'graphql',
                      endpoint: '{{baseUrl}}/orders/{{orderId}}',
                      body: 'query { ping }',
                      variables: '{}',
                      headers: [],
                      authentication: { type: 'none' },
                    },
                  ],
                },
              ],
            },
          ],
        })
        window.localStorage.setItem(
          'alcy:workbench-tabs:/workspace',
          JSON.stringify({ openRequestIds: ['request-1'], activeRequestId: 'request-1' }),
        )

        executeGraphqlRequest.mockResolvedValue({
          ok: true,
          value: { statusCode: 200, durationMs: 5, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scopedChanges: [], scriptLogs: [], scriptError: null, testResults: [] },
        })

        render()
        await screen.findByLabelText('Ambiente')
        expect(await within(openTabsBar()).findByRole('tab', { name: 'Pedido', selected: true })).toBeInTheDocument()

        const knownTokens = [...document.querySelectorAll('.var-token--known')].map((token) => token.textContent)
        expect(knownTokens).toEqual(['{{baseUrl}}', '{{orderId}}'])
        hoverTemplateToken(document.querySelectorAll('.var-token--known')[1])
        expect(await screen.findByText('Da pasta Pedidos')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

        await waitFor(() => expect(executeGraphqlRequest).toHaveBeenCalled())
        const input = executeGraphqlRequest.mock.calls[0][0]
        expect(input.environmentVariables).toEqual([])
        expect(input.variableScopes).toEqual([
          { nodeId: 'collection-1', kind: 'collection', variables: [{ name: 'baseUrl', value: 'https://collection.example.com' }] },
          { nodeId: 'folder-1', kind: 'folder', variables: [{ name: 'orderId', value: '42' }] },
        ])
      })

      it('enviar numa aba e trocar de aba antes da resposta chegar atualiza a aba de origem, não a aba ativa', async () => {
        let resolveExecution: (value: unknown) => void = () => {}
        executeGraphqlRequest.mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveExecution = resolve
            }),
        )

        render()
        await screen.findByLabelText('Ambiente')
        openCollectionsTab()
        createCollection()
        addRequestNamed('Request A')
        createRequestFromTabsBar('GraphQL')
        fireEvent.click(within(openTabsBar()).getByRole('tab', { name: 'Request A' }))

        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        expect(screen.getByText('Enviando requisição…')).toBeInTheDocument()

        fireEvent.click(within(openTabsBar()).getByRole('tab', { name: 'Nova requisição' }))
        expect(screen.getByText('Nenhuma requisição enviada')).toBeInTheDocument()

        resolveExecution({
          ok: true,
          value: { statusCode: 200, durationMs: 5, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
        })

        fireEvent.click(within(openTabsBar()).getByRole('tab', { name: 'Request A' }))
        expect(await findStatusText(/200/)).toBeInTheDocument()
      })
    })

    describe('salvar e abrir requisições', () => {
      const createCollection = () => {
        fireEvent.click(addRequestButton())
        fireEvent.click(screen.getByRole('option', { name: 'Criar Collection' }))
        fireEvent.keyDown(within(collectionsSidebar()).getByLabelText('Nome'), { key: 'Enter' })
      }

      it('mostra a modal de salvar com destino vazio quando não há nenhuma Collection', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()

        fireEvent.keyDown(document, { key: 's', ctrlKey: true })

        const dialog = screen.getByRole('dialog', { name: 'Salvar requisição' })
        expect(within(dialog).getByText('Crie uma Collection antes de salvar uma requisição.')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeDisabled()
        expect(within(dialog).getByRole('button', { name: 'Nova collection' })).toBeEnabled()
      })

      it('cria uma collection pela própria modal, entra nela e salva a requisição', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        fireEvent.keyDown(document, { key: 's', ctrlKey: true })
        const dialog = screen.getByRole('dialog', { name: 'Salvar requisição' })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Nova collection' }))
        const collectionName = within(dialog).getByLabelText('Nome da nova collection')
        fireEvent.change(collectionName, { target: { value: 'Pagamentos' } })
        fireEvent.keyDown(collectionName, { key: 'Enter' })

        expect(within(dialog).getByText('Pagamentos')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeEnabled()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Pagamentos')).toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Nova requisição')).toHaveAttribute('aria-current', 'true')
      })

      it('dentro de uma collection, o botão do rodapé vira "Nova pasta" e cria a pasta no nível atual', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        fireEvent.keyDown(document, { key: 's', ctrlKey: true })
        const dialog = screen.getByRole('dialog', { name: 'Salvar requisição' })
        expect(within(dialog).getByRole('button', { name: 'Nova collection' })).toBeInTheDocument()
        expect(within(dialog).queryByRole('button', { name: 'Nova pasta' })).not.toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Nova Collection' }))
        expect(within(dialog).queryByRole('button', { name: 'Nova collection' })).not.toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Nova pasta' }))
        const folderName = within(dialog).getByLabelText('Nome da nova pasta')
        fireEvent.change(folderName, { target: { value: 'Faturas' } })
        fireEvent.keyDown(folderName, { key: 'Enter' })

        expect(within(dialog).getByText('Nova Collection / Faturas')).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        const savedRow = within(collectionsSidebar()).getByText('Nova requisição')
        expect(savedRow.closest('.collections-node')?.parentElement?.closest('.collections-node')).toHaveTextContent('Faturas')
      })

      it('navega collection → subpasta, volta um nível e salva no destino escolhido', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()
        openMenu('Nova Collection')
        fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar pasta' }))
        const folderNameInput = within(collectionsSidebar()).getByLabelText('Nome')
        fireEvent.change(folderNameInput, { target: { value: 'Pedidos' } })
        fireEvent.keyDown(folderNameInput, { key: 'Enter' })

        fireEvent.keyDown(document, { key: 's', ctrlKey: true })
        const dialog = screen.getByRole('dialog', { name: 'Salvar requisição' })
        expect(within(dialog).getByLabelText('Nome da requisição')).toHaveValue('Nova requisição')
        expect(within(dialog).getByText('Selecione uma collection')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Salvar' })).toBeDisabled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Nova Collection' }))
        expect(within(dialog).getByText('Nova Collection', { selector: '.destination-browser-breadcrumb' })).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Pedidos' }))
        expect(within(dialog).getByText('Nova Collection / Pedidos')).toBeInTheDocument()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Voltar' }))
        expect(within(dialog).getByText('Nova Collection', { selector: '.destination-browser-breadcrumb' })).toBeInTheDocument()
        fireEvent.change(within(dialog).getByLabelText('Buscar collection ou pasta'), { target: { value: 'xyz' } })
        expect(within(dialog).getByText('Nenhuma pasta encontrada.')).toBeInTheDocument()
        fireEvent.change(within(dialog).getByLabelText('Buscar collection ou pasta'), { target: { value: 'ped' } })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Pedidos' }))

        fireEvent.change(within(dialog).getByLabelText('Nome da requisição'), { target: { value: 'Listar pedidos' } })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        const savedRow = within(collectionsSidebar()).getByText('Listar pedidos')
        expect(savedRow).toHaveAttribute('aria-current', 'true')
        expect(savedRow.closest('.collections-node')?.parentElement?.closest('.collections-node')).toHaveTextContent('Pedidos')
        expect(screen.getByRole('tab', { name: 'Listar pedidos' })).toBeInTheDocument()
      })

      it('salva a requisição atual em uma Collection escolhida e marca a requisição como aberta', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        createRequestFromTabsBar('GraphQL')
        openCollectionsTab()
        createCollection()

        pasteIntoQueryEditor('query { myField }')
        fireEvent.keyDown(document, { key: 's', ctrlKey: true })

        const dialog = screen.getByRole('dialog', { name: 'Salvar requisição' })
        fireEvent.change(within(dialog).getByLabelText('Nome da requisição'), { target: { value: 'My request' } })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Nova Collection' }))
        fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('My request')).toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('My request')).toHaveAttribute(
          'aria-current',
          'true',
        )
      })

      it('salva uma requisição REST com método e corpo, e preserva ambos ao reabrir pela árvore', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        createRequestFromTabsBar('REST')

        fireEvent.change(screen.getByRole('combobox', { name: 'Método HTTP' }), { target: { value: 'put' } })
        fireEvent.click(screen.getByRole('tab', { name: 'Body' }))
        pasteIntoBodyEditor('{"status":"paid"}')

        openCollectionsTab()
        createCollection()

        fireEvent.keyDown(document, { key: 's', ctrlKey: true })
        const dialog = screen.getByRole('dialog', { name: 'Salvar requisição' })
        fireEvent.change(within(dialog).getByLabelText('Nome da requisição'), { target: { value: 'Update order' } })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Nova Collection' }))
        fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(within(collectionsSidebar()).getByText('Update order')).toBeInTheDocument()

        const openTabsBar = screen.getByRole('tablist', { name: 'Requisições abertas' })
        fireEvent.click(within(openTabsBar).getByRole('button', { name: /Fechar aba/ }))

        fireEvent.click(within(collectionsSidebar()).getByText('Update order'))

        expect(screen.getByRole('tab', { name: 'Params', selected: true })).toBeInTheDocument()
        expect(screen.getByRole('combobox', { name: 'Método HTTP' })).toHaveValue('put')
        fireEvent.click(screen.getByRole('tab', { name: 'Body' }))
        expect(bodyEditorText()).toBe('{"status":"paid"}')
      })

      it('sobrescreve a requisição aberta ao clicar em Salvar de novo, sem abrir a modal, e o conteúdo persiste ao reabri-la', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Request A')

        addRequestTo('Nova Collection', 'Request B')

        fireEvent.click(within(collectionsSidebar()).getByText('Request A'))
        pasteIntoQueryEditor('query { updated }')
        fireEvent.keyDown(document, { key: 's', ctrlKey: true })

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        fireEvent.click(within(collectionsSidebar()).getByText('Request B'))
        expect(queryEditorText()).toBe('')

        fireEvent.click(within(collectionsSidebar()).getByText('Request A'))
        expect(queryEditorText()).toBe('query { updated }')
      })

      it('salva uma aba em segundo plano pelo menu de contexto, sem trocar a aba ativa', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Request A')

        addRequestTo('Nova Collection', 'Request B')

        fireEvent.click(within(collectionsSidebar()).getByText('Request A'))
        pasteIntoQueryEditor('query { updated }')
        fireEvent.click(within(collectionsSidebar()).getByText('Request B'))

        const openTabsBar = screen.getByRole('tablist', { name: 'Requisições abertas' })
        const requestATab = within(openTabsBar).getByRole('tab', { name: 'Request A' }).closest('.rw-open-tab')!
        fireEvent.contextMenu(requestATab)
        fireEvent.click(screen.getByRole('menuitem', { name: 'Salvar' }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(within(openTabsBar).getByRole('tab', { name: 'Request B', selected: true })).toBeInTheDocument()
        expect(queryEditorText()).toBe('')

        fireEvent.click(within(collectionsSidebar()).getByText('Request A'))
        expect(queryEditorText()).toBe('query { updated }')
      })

      it('desabilita a opção "Salvar" do menu de contexto quando a aba não tem alterações', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Request A')

        const openTabsBar = screen.getByRole('tablist', { name: 'Requisições abertas' })
        const requestATab = within(openTabsBar).getByRole('tab', { name: 'Request A' }).closest('.rw-open-tab')!

        fireEvent.contextMenu(requestATab)
        expect(screen.getByRole('menuitem', { name: 'Salvar' })).toBeDisabled()

        // Disabled Save must not receive autofocus; another menu item preserves Escape/outside-click handling.
        expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true)
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()

        pasteIntoQueryEditor('query { updated }')

        fireEvent.contextMenu(requestATab)
        expect(screen.getByRole('menuitem', { name: 'Salvar' })).toBeEnabled()
        expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true)
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      })

      it('CTRL+S não faz nada quando a aba ativa não tem alterações', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Request A')

        fireEvent.keyDown(document, { key: 's', ctrlKey: true })
        expect(screen.queryByText('Requisição salva.')).not.toBeInTheDocument()

        pasteIntoQueryEditor('query { updated }')
        fireEvent.keyDown(document, { key: 's', ctrlKey: true })
        expect(await screen.findByText('Requisição salva.')).toBeInTheDocument()
      })

      it('abre uma requisição salva ao clicar nela, carregando endpoint e query no editor', async () => {
        listCollections.mockResolvedValue({
          ok: true,
          value: [
            {
              id: 'collection-1',
              name: 'Customer API',
              folders: [],
              authentication: { type: 'inherit' },
              requests: [
                {
                  id: 'request-1',
                  name: 'Get current customer',
                  protocol: 'graphql',
                  endpoint: 'https://api.example.com/graphql',
                  body: 'query { currentCustomer { id } }',
                  variables: '{"id": 1}',
                  headers: [{ name: 'X-Custom', value: '1', enabled: true }],
                  authentication: { type: 'none' },
                },
              ],
            },
          ],
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()

        fireEvent.click(await within(collectionsSidebar()).findByRole('button', { name: 'Expandir Customer API' }))
        fireEvent.click(within(collectionsSidebar()).getByText('Get current customer'))

        expect(screen.getByLabelText('Endpoint')).toHaveValue('https://api.example.com/graphql')
        expect(queryEditorText()).toBe('query { currentCustomer { id } }')
      })

      it('criar uma requisição pelo menu "⋯" já abre o editor com o conteúdo vazio', async () => {
        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Fresh request')

        expect(queryEditorText()).toBe('')
        expect(within(collectionsSidebar()).getByText('Fresh request')).toHaveAttribute(
          'aria-current',
          'true',
        )
      })

      it('limpa a resposta da requisição anterior ao abrir outra requisição', async () => {
        executeGraphqlRequest.mockResolvedValue({
          ok: true,
          value: { statusCode: 200, durationMs: 5, sizeBytes: 2, body: { kind: 'inline', body: '{}' }, bodyEncoding: 'text', headers: [], requestHeaders: [], cookies: [], connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false }, finalUrl: null, waitingMs: 0, graphqlErrors: [], environmentChanges: [], scriptLogs: [], scriptError: null },
        })

        render()
        await screen.findByLabelText('Ambiente')
        await createRequestFromEmptyState()
        openCollectionsTab()
        createCollection()

        addRequestTo('Nova Collection', 'Request A')

        addRequestTo('Nova Collection', 'Request B')

        fireEvent.click(within(collectionsSidebar()).getByText('Request A'))
        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
        await findStatusText(/200/)

        fireEvent.click(within(collectionsSidebar()).getByText('Request B'))

        expect(screen.queryByText(/200/)).not.toBeInTheDocument()
        expect(screen.getByText('Nenhuma requisição enviada')).toBeInTheDocument()
      })
    })
  })

  it('preenche autorização Bearer e Basic na aba Authorization', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()
    fireEvent.click(screen.getByRole('tab', { name: 'Authorization' }))

    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument()

    const chooseType = (name: string) => {
      fireEvent.click(screen.getByLabelText('Tipo'))
      fireEvent.click(screen.getByRole('option', { name }))
    }

    chooseType('Bearer token')
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'secret-token' } })
    expect(screen.getByLabelText('Token')).toHaveValue('secret-token')
    expect(screen.queryByLabelText('Usuário')).not.toBeInTheDocument()

    chooseType('Basic auth')
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Usuário'), { target: { value: 'ana' } })
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'hunter2' } })
    expect(screen.getByLabelText('Usuário')).toHaveValue('ana')
    expect(screen.getByLabelText('Senha')).toHaveValue('hunter2')

    chooseType('Nenhuma')
    expect(screen.queryByLabelText('Usuário')).not.toBeInTheDocument()
  })

  const sampleSchema = () => ({
    queryType: 'Query',
    mutationType: null,
    subscriptionType: null,
    directives: [],
    types: [
      {
        name: 'Query',
        kind: 'OBJECT',
        description: 'Raiz de consultas',
        fields: [
          {
            name: 'currentCustomer',
            description: 'Cliente autenticado',
            args: [],
            typeDisplay: 'Customer',
            typeName: 'Customer',
            isDeprecated: false,
            deprecationReason: null,
          },
        ],
        inputFields: [],
        enumValues: [],
        interfaces: [],
        possibleTypes: [],
      },
      {
        name: 'Customer',
        kind: 'OBJECT',
        description: null,
        fields: [
          {
            name: 'id',
            description: null,
            args: [],
            typeDisplay: 'ID!',
            typeName: 'ID',
            isDeprecated: false,
            deprecationReason: null,
          },
          {
            name: 'name',
            description: null,
            args: [],
            typeDisplay: 'String!',
            typeName: 'String',
            isDeprecated: false,
            deprecationReason: null,
          },
        ],
        inputFields: [],
        enumValues: [],
        interfaces: [],
        possibleTypes: [],
      },
    ],
  })

  it('pede carregamento explícito do schema e mostra o estado vazio', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))

    expect(screen.getByText('Carregue o schema para explorar tipos, campos e documentação.')).toBeInTheDocument()
    expect(loadSchema).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    expect(loadSchema).toHaveBeenCalledTimes(1)
    expect(loadSchema.mock.calls[0][0].forceRefresh).toBe(false)
    await screen.findByText('Raiz de consultas')
  })

  const graphqlCollectionWithSavedRequest = () => ({
    ok: true as const,
    value: [
      {
        id: 'collection-1',
        name: 'Customer API',
        folders: [],
        authentication: { type: 'inherit' },
        requests: [
          {
            id: 'request-1',
            name: 'Ping',
            protocol: 'graphql' as const,
            endpoint: 'https://api.example.com/graphql',
            body: 'query { ping }',
            variables: '{}',
            headers: [],
            authentication: { type: 'none' as const },
          },
        ],
      },
    ],
  })

  it('abre uma requisição GraphQL salva e carrega o schema sozinho, sem exigir "Carregar schema"', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })
    listCollections.mockResolvedValue(graphqlCollectionWithSavedRequest())

    render()
    await screen.findByLabelText('Ambiente')
    fireEvent.click(await screen.findByRole('button', { name: 'Expandir Customer API' }))
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Collections' })).getByText('Ping'))

    expect(await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })).toBeInTheDocument()
    expect(loadSchema).toHaveBeenCalledTimes(1)
    expect(loadSchema.mock.calls[0][0].forceRefresh).toBe(false)
    expect(screen.queryByRole('button', { name: 'Carregar schema' })).not.toBeInTheDocument()
  })

  it('recolhe tudo e localiza a requisição aberta reexpandindo suas pastas', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })
    listCollections.mockResolvedValue(graphqlCollectionWithSavedRequest())

    render()
    await screen.findByLabelText('Ambiente')
    const sidebar = within(screen.getByRole('complementary', { name: 'Collections' }))
    expect(sidebar.getByRole('button', { name: 'Localizar requisição aberta' })).toBeDisabled()

    fireEvent.click(await screen.findByRole('button', { name: 'Expandir Customer API' }))
    fireEvent.click(sidebar.getByText('Ping'))

    fireEvent.click(sidebar.getByRole('button', { name: 'Recolher tudo' }))
    expect(sidebar.queryByText('Ping')).not.toBeInTheDocument()
    // Once collapsed, the same button expands the whole tree.
    expect(sidebar.getByRole('button', { name: 'Expandir tudo' })).toBeEnabled()

    fireEvent.click(sidebar.getByRole('button', { name: 'Localizar requisição aberta' }))
    expect(await sidebar.findByText('Ping')).toBeInTheDocument()
  })

  it('fechar e reabrir a mesma requisição salva volta a carregar o schema sozinho', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })
    listCollections.mockResolvedValue(graphqlCollectionWithSavedRequest())

    render()
    await screen.findByLabelText('Ambiente')
    fireEvent.click(await screen.findByRole('button', { name: 'Expandir Customer API' }))
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Collections' })).getByText('Ping'))
    await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })
    expect(loadSchema).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Fechar aba Ping' }))
    expect(screen.queryByRole('tab', { name: 'Ping' })).not.toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('complementary', { name: 'Collections' })).getByText('Ping'))

    expect(await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })).toBeInTheDocument()
    expect(loadSchema).toHaveBeenCalledTimes(2)
    expect(loadSchema.mock.calls[1][0].forceRefresh).toBe(false)
  })

  it('trocar de seção e voltar para Query não recarrega o schema já obtido', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })
    listCollections.mockResolvedValue(graphqlCollectionWithSavedRequest())

    render()
    await screen.findByLabelText('Ambiente')
    fireEvent.click(await screen.findByRole('button', { name: 'Expandir Customer API' }))
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Collections' })).getByText('Ping'))
    await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })
    expect(loadSchema).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Query' }))

    expect(await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })).toBeInTheDocument()
    expect(loadSchema).toHaveBeenCalledTimes(1)
  })

  it('carrega o schema, lista tipos e navega até um tipo referenciado', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    expect(await screen.findByText('Raiz de consultas')).toBeInTheDocument()
    expect(screen.getByText('currentCustomer')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Customer' }))

    expect(await screen.findByText('id')).toBeInTheDocument()
    expect(screen.getByText('name')).toBeInTheDocument()
  })

  it('filtra tipos pela busca na aba Schema', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))
    await screen.findByLabelText('Tipos e diretivas do schema')

    // name matches Customer.name; Query.currentCustomer matches customer but not name.
    fireEvent.change(screen.getByPlaceholderText('Buscar tipo, diretiva ou campo…'), { target: { value: 'name' } })

    const typeList = screen.getByLabelText('Tipos e diretivas do schema')
    expect(within(typeList).getByRole('button', { name: /Customer/ })).toBeInTheDocument()
    expect(within(typeList).queryByRole('button', { name: /Query/ })).not.toBeInTheDocument()
  })

  it('mostra Cancelar durante o carregamento do schema e aciona o cancelamento', async () => {
    let resolveLoad: (value: unknown) => void = () => {}
    loadSchema.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
    )

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    const cancelButton = await screen.findByRole('button', { name: 'Cancelar' })
    fireEvent.click(cancelButton)

    expect(cancelGraphqlRequest).toHaveBeenCalledTimes(1)
    const sentExecutionId = loadSchema.mock.calls[0][0].executionId
    expect(cancelGraphqlRequest).toHaveBeenCalledWith(sentExecutionId)

    resolveLoad({ ok: false, error: { kind: 'cancelled' } })
    expect(await screen.findByText('Carregamento cancelado.')).toBeInTheDocument()
  })

  it('mostra erro do schema e permite tentar novamente', async () => {
    loadSchema.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'connection refused' } })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    expect(await screen.findByText('Falha de rede: connection refused')).toBeInTheDocument()

    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByText('Raiz de consultas')).toBeInTheDocument()
  })

  it('atualiza o schema ignorando o cache ao clicar em Atualizar schema', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))
    await screen.findByText('Raiz de consultas')

    fireEvent.click(screen.getByRole('button', { name: 'Atualizar schema' }))

    expect(loadSchema).toHaveBeenCalledTimes(2)
    expect(loadSchema.mock.calls[1][0].forceRefresh).toBe(true)
  })

  it('carrega o schema e marca um campo no painel ao lado da query, sem trocar de aba', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    // Query starts active and its sidebar loads the schema automatically.
    pasteIntoQueryEditor('')
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    const checkbox = await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })
    fireEvent.click(checkbox)

    expect(queryEditorText()).toBe('{\n  currentCustomer {}\n}')
    expect(checkbox).toBeChecked()
  })

  it('clicar duas vezes no mesmo campo remove em vez de duplicar', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    pasteIntoQueryEditor('')
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    const checkbox = await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })
    fireEvent.click(checkbox)
    fireEvent.click(checkbox)

    expect(queryEditorText()).toBe('{}')
    expect(checkbox).not.toBeChecked()
  })

  it('organiza (beautify) a query ao clicar no ícone de formatação', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    pasteIntoQueryEditor('{currentCustomer{id name}}')
    fireEvent.click(screen.getByRole('button', { name: 'Organizar query' }))

    expect(queryEditorText()).toBe('{\n  currentCustomer {\n    id\n    name\n  }\n}')
  })

  it('desabilita o ícone de organizar quando a query está vazia ou inválida', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    pasteIntoQueryEditor('')
    expect(screen.getByRole('button', { name: 'Organizar query' })).toBeDisabled()

    pasteIntoQueryEditor('{ currentCustomer {')
    expect(screen.getByRole('button', { name: 'Organizar query' })).toBeDisabled()

    pasteIntoQueryEditor('{ currentCustomer { id } }')
    expect(screen.getByRole('button', { name: 'Organizar query' })).toBeEnabled()
  })

  it('expande um campo pelo nome sem marcá-lo, só para navegar pelos subcampos', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    pasteIntoQueryEditor('')
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    // Clicking a field name expands it without selecting it or editing the query.
    fireEvent.click(await screen.findByRole('button', { name: 'currentCustomer' }))

    const idCheckbox = await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer > id à query' })
    expect(idCheckbox).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })).not.toBeChecked()
    expect(queryEditorText()).toBe('')
  })

  it('marcar um subcampo direto cascateia a seleção do campo pai, sem precisar marcá-lo antes', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    pasteIntoQueryEditor('')
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    fireEvent.click(await screen.findByRole('button', { name: 'currentCustomer' }))
    const idCheckbox = await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer > id à query' })
    fireEvent.click(idCheckbox)

    expect(queryEditorText()).toBe('{\n  currentCustomer {\n    id\n  }\n}')
    expect(screen.getByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })).toBeChecked()
  })

  it('digitar um valor de argumento cascateia a seleção do campo e mantém a query válida', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: richSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    pasteIntoQueryEditor('')
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    fireEvent.click(await screen.findByRole('button', { name: 'legacyPing' }))
    const limitInput = await screen.findByLabelText('Valor do argumento limit em legacyPing')
    fireEvent.change(limitInput, { target: { value: '5' } })

    expect(queryEditorText()).toBe('{\n  legacyPing(limit: 5)\n}')
    expect(screen.getByRole('checkbox', { name: 'Adicionar campo legacyPing à query' })).toBeChecked()

    fireEvent.change(limitInput, { target: { value: '' } })
    expect(queryEditorText()).toBe('{\n  legacyPing\n}')
  })

  it('o checkbox do argumento reflete se ele está presente e, ao marcar, usa o valor padrão do schema', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: richSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    pasteIntoQueryEditor('')
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    fireEvent.click(await screen.findByRole('button', { name: 'legacyPing' }))
    const argCheckbox = await screen.findByRole('checkbox', { name: 'Incluir argumento limit em legacyPing' })
    expect(argCheckbox).not.toBeChecked()

    fireEvent.click(argCheckbox)

    expect(queryEditorText()).toBe('{\n  legacyPing(limit: 10)\n}')
    expect(argCheckbox).toBeChecked()

    fireEvent.click(argCheckbox)

    expect(queryEditorText()).toBe('{\n  legacyPing\n}')
    expect(argCheckbox).not.toBeChecked()
  })

  const richSchema = () => ({
    queryType: 'Query',
    mutationType: null,
    subscriptionType: null,
    directives: [
      {
        name: 'cacheControl',
        description: 'Controla o cache do campo',
        locations: ['FIELD', 'OBJECT'],
        args: [{ name: 'maxAge', description: null, typeDisplay: 'Int', typeName: 'Int', defaultValue: '60' }],
      },
    ],
    types: [
      {
        name: 'Query',
        kind: 'OBJECT',
        description: null,
        fields: [
          {
            name: 'legacyPing',
            description: null,
            args: [{ name: 'limit', description: null, typeDisplay: 'Int', typeName: 'Int', defaultValue: '10' }],
            typeDisplay: 'Boolean',
            typeName: 'Boolean',
            isDeprecated: true,
            deprecationReason: 'Use ping em vez disso',
          },
        ],
        inputFields: [],
        enumValues: [],
        interfaces: ['Node'],
        possibleTypes: [],
      },
      {
        name: 'Node',
        kind: 'INTERFACE',
        description: 'Identificável globalmente',
        fields: [],
        inputFields: [],
        enumValues: [],
        interfaces: [],
        possibleTypes: ['Query'],
      },
    ],
  })

  it('mostra campo descontinuado com motivo e valor padrão do argumento', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: richSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    expect(await screen.findByText('descontinuado')).toHaveAttribute('title', 'Use ping em vez disso')
    expect(screen.getByText(/limit: Int = 10/)).toBeInTheDocument()
  })

  it('mostra interfaces implementadas e navega até elas', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: richSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    await screen.findByText(/Implementa/)
    fireEvent.click(screen.getByRole('button', { name: 'Node' }))

    expect(await screen.findByText('Identificável globalmente')).toBeInTheDocument()
    expect(screen.getByText(/Tipos possíveis/)).toBeInTheDocument()
  })

  it('lista diretivas do schema e mostra localizações e argumentos ao selecionar', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: richSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))

    const typeList = await screen.findByLabelText('Tipos e diretivas do schema')
    fireEvent.click(within(typeList).getByRole('button', { name: /cacheControl/ }))

    expect(await screen.findByText('Controla o cache do campo')).toBeInTheDocument()
    expect(screen.getByText('Localizações: FIELD, OBJECT')).toBeInTheDocument()
    expect(screen.getByText(/maxAge/)).toBeInTheDocument()
  })

  it('avisa quando a query digitada referencia um campo que não existe no schema', async () => {
    loadSchema.mockResolvedValue({ ok: true, value: sampleSchema() })

    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')

    fireEvent.click(screen.getByRole('button', { name: 'Carregar schema' }))
    await screen.findByRole('checkbox', { name: 'Adicionar campo currentCustomer à query' })

    pasteIntoQueryEditor('{ doesNotExist }')

    expect(await screen.findByText('Campo "doesNotExist" não existe em "Query".')).toBeInTheDocument()
  })

  it('abre o menu de configurações, troca o idioma para inglês e traduz a interface', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()

    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }))

    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    expect(within(dialog).getByRole('button', { name: 'Geral' })).toHaveAttribute('aria-current', 'page')
    expect(await within(dialog).findByRole('spinbutton', { name: 'Timeout em segundos' })).toHaveValue(60)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Aparência' }))
    expect(within(dialog).getByRole('radio', { name: 'Claro' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Escuro' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('alcy:theme')).toBe('dark')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Geral' }))
    expect(within(dialog).getByRole('radio', { name: 'Português (Brasil)' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByRole('radio', { name: 'English' })).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(within(dialog).getByRole('radio', { name: 'English' }))

    expect(within(dialog).getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(window.localStorage.getItem('alcy:language')).toBe('en')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Environment')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()

    // proves the translation reaches deeply nested feature components, not just the header slice
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Collections' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Environments' }))
    const englishSidebar = screen.getByRole('complementary', { name: 'Environments' })
    expect(within(englishSidebar).getByText('New environment')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    expect(screen.getByText('Add header')).toBeInTheDocument()
  })

  it('fecha o menu de configurações com Escape sem alterar o idioma', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()

    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Ambiente')).toBeInTheDocument()
  })

  it('abre as novidades da versão só na primeira abertura dela', async () => {
    window.localStorage.removeItem('alcy:release-notes:seen-version')
    const { unmount } = render()

    expect(await screen.findByRole('heading', { level: 1, name: 'Novidades da versão 9.9.9' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Destaques' })).toBeInTheDocument()
    expect(screen.getByText('Aba de novidades')).toBeInTheDocument()
    unmount()

    render()
    await screen.findByLabelText('Ambiente')
    await screen.findByRole('button', { name: 'Nova requisição REST' })
    expect(screen.queryByRole('heading', { name: 'Novidades da versão 9.9.9' })).not.toBeInTheDocument()
  })

  it('abre as novidades da versão pelas configurações gerais', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    await createRequestFromEmptyState()

    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }))
    const dialog = screen.getByRole('dialog', { name: 'Configurações' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ver novidades' }))

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 1, name: 'Novidades da versão 9.9.9' })).toBeInTheDocument()
  })

  describe('documentação importada', () => {
    const schemaNode = (overrides: Record<string, unknown>) => ({
      refName: null,
      types: [],
      format: null,
      title: null,
      description: '',
      nullable: false,
      deprecated: false,
      readOnly: false,
      writeOnly: false,
      enumValues: [],
      default: null,
      example: null,
      properties: [],
      required: [],
      items: null,
      additionalProperties: null,
      allOf: [],
      oneOf: [],
      anyOf: [],
      ...overrides,
    })

    const openDocumentedRequest = async () => {
      listCollections.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'collection-1',
            name: 'Pet Store',
            folders: [],
            authentication: { type: 'inherit' },
            requests: [
              {
                id: 'request-1',
                name: 'List pets',
                protocol: 'rest',
                endpoint: 'https://api.example.com/pets',
                method: 'get',
                body: '',
                variables: '',
                headers: [],
                authentication: { type: 'none' },
                preRequestScript: '',
                postResponseScript: '',
                docsRef: { sourceId: 'source-1', operationId: 'listPets' },
              },
            ],
          },
        ],
      })
      getRequestDocs.mockResolvedValue({
        ok: true,
        value: {
          sourceTitle: 'Pet Store',
          sourceKind: 'openapi',
          summary: 'Lista os pets',
          description: '',
          deprecated: false,
          parameters: [
            {
              name: 'status',
              location: 'query',
              required: false,
              deprecated: false,
              description: 'Filtra por status',
              schema: schemaNode({ types: ['string'], enumValues: ['"available"', '"sold"'] }),
              example: null,
            },
          ],
          requestBody: null,
          responses: [],
          schemas: {},
        },
      })

      render()
      await screen.findByLabelText('Ambiente')
      const componentsTab = screen.getByRole('tab', { name: 'Componentes' })
      if (componentsTab.getAttribute('aria-selected') !== 'true') fireEvent.click(componentsTab)
      const collectionsSidebar = screen.getByRole('complementary', { name: 'Collections' })
      fireEvent.click(await within(collectionsSidebar).findByRole('button', { name: 'Expandir Pet Store' }))
      fireEvent.click(within(collectionsSidebar).getByText('List pets'))
    }

    /** Open Docs, await binding/session-cached documentation, then return to Params. */
    const waitForDocs = async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Docs' }))
      expect(await screen.findByRole('heading', { name: 'Lista os pets' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: 'Params' }))
    }

    it('mostra a aba Docs antes de Params e carrega a documentação da requisição', async () => {
      await openDocumentedRequest()

      const sections = screen.getByRole('tablist', { name: 'Seções da requisição' })
      const names = within(sections)
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
      expect(names.slice(0, 2)).toEqual(['Docs', 'Params'])

      fireEvent.click(within(sections).getByRole('tab', { name: 'Docs' }))
      expect(await screen.findByRole('heading', { name: 'Lista os pets' })).toBeInTheDocument()
      expect(getRequestDocs).toHaveBeenCalledWith('/workspace', { sourceId: 'source-1', operationId: 'listPets' })
    })

    it('sugere nomes e valores de query params a partir da documentação', async () => {
      await openDocumentedRequest()
      await waitForDocs()

      fireEvent.click(screen.getByRole('button', { name: 'Adicionar parâmetro' }))
      const nameInputs = screen.getAllByLabelText('Nome do parâmetro')
      const nameInput = nameInputs[nameInputs.length - 1]
      fireEvent.change(nameInput, { target: { value: 'st' } })
      expect(await screen.findByRole('listbox', { name: 'Sugestões da documentação' })).toHaveTextContent('Filtra por status')
      fireEvent.keyDown(nameInput, { key: 'Enter' })
      expect(nameInput).toHaveValue('status')

      const valueInputs = screen.getAllByLabelText('Valor do parâmetro')
      const valueInput = valueInputs[valueInputs.length - 1]
      fireEvent.keyDown(valueInput, { key: 'ArrowDown' })
      const values = screen.getByRole('listbox', { name: 'Sugestões da documentação' })
      expect(values).toHaveTextContent('available')
      expect(values).toHaveTextContent('sold')
    })

    it('não sugere nada com a preferência desligada, mas mantém a aba Docs', async () => {
      window.localStorage.setItem('alcy:schema-autocomplete', 'false')
      onTestFinished(() => window.localStorage.removeItem('alcy:schema-autocomplete'))
      await openDocumentedRequest()
      // Docs still works when suggestions are disabled.
      await waitForDocs()

      fireEvent.click(screen.getByRole('button', { name: 'Adicionar parâmetro' }))
      const nameInputs = screen.getAllByLabelText('Nome do parâmetro')
      fireEvent.change(nameInputs[nameInputs.length - 1], { target: { value: 'st' } })
      expect(screen.queryByRole('listbox', { name: 'Sugestões da documentação' })).not.toBeInTheDocument()
    })
  })
})

describe('RequestWorkbench — painel do agente', () => {
  it('removes an open chat and disables its shortcut immediately until reenabled', async () => {
    featureFlags.agent = true
    onTestFinished(() => { featureFlags.agent = false })
    render(<>
      <RequestWorkbench workspace={testWorkspace} onWorkspaceChange={() => {}} onExitToStartScreen={() => {}} />
      <AgentSection />
    </>)
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar painel do agente' }))
    expect(await screen.findByRole('complementary', { name: 'Agente' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Desabilitar opções nos subcontextos' }))
    expect(screen.getByRole('complementary', { name: 'Agente' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Habilitar chat' }))
    expect(screen.queryByRole('complementary', { name: 'Agente' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /painel do agente/ })).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('complementary', { name: 'Agente' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Habilitar chat' }))
    expect(await screen.findByRole('complementary', { name: 'Agente' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ocultar painel do agente' })).toBeInTheDocument()
  })

  it('keeps the panel mounted while closed and remembers whether it was open', async () => {
    featureFlags.agent = true
    onTestFinished(() => {
      featureFlags.agent = false
    })
    const { unmount } = render()
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar painel do agente' }))
    const panel = await screen.findByRole('complementary', { name: 'Agente' })
    expect(window.localStorage.getItem('alcy:panel:agent-open')).toBe('open')

    fireEvent.click(screen.getByRole('button', { name: 'Ocultar painel do agente' }))
    expect(panel).toBeInTheDocument()
    expect(panel.closest('.agent-panel-wrapper')).toHaveAttribute('hidden')
    expect(window.localStorage.getItem('alcy:panel:agent-open')).toBe('closed')

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar painel do agente' }))
    expect(screen.getByRole('complementary', { name: 'Agente' })).toBe(panel)

    unmount()
    render()
    expect(await screen.findByRole('complementary', { name: 'Agente' })).toBeInTheDocument()
  })

  it('docks the panel at the side chosen in Settings without remounting it', async () => {
    featureFlags.agent = true
    onTestFinished(() => {
      featureFlags.agent = false
    })
    // An unknown stored position falls back to the right.
    window.localStorage.setItem('alcy:agent:dock', 'top')
    render(<>
      <RequestWorkbench workspace={testWorkspace} onWorkspaceChange={() => {}} onExitToStartScreen={() => {}} />
      <AgentSection />
    </>)
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar painel do agente' }))
    const panel = await screen.findByRole('complementary', { name: 'Agente' })
    expect(panel.closest('.rw-body')).toHaveClass('rw-body--agent-right')

    fireEvent.click(screen.getByRole('radio', { name: 'Embaixo' }))
    expect(panel.closest('.rw-body')).toHaveClass('rw-body--agent-bottom')
    expect(screen.getByRole('separator', { name: 'Redimensionar painel do agente' })).toHaveAttribute('aria-orientation', 'horizontal')
    expect(screen.getByRole('complementary', { name: 'Agente' })).toBe(panel)
    expect(window.localStorage.getItem('alcy:agent:dock')).toBe('bottom')
  })

  it('docked on the left, becomes a sidebar module holding the same chat', async () => {
    featureFlags.agent = true
    onTestFinished(() => {
      featureFlags.agent = false
    })
    render(<>
      <RequestWorkbench workspace={testWorkspace} onWorkspaceChange={() => {}} onExitToStartScreen={() => {}} />
      <AgentSection />
    </>)
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar painel do agente' }))
    const panel = await screen.findByRole('complementary', { name: 'Agente' })
    expect(screen.queryByRole('tab', { name: 'Agente' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Esquerda' }))
    const moduleTab = screen.getByRole('tab', { name: 'Agente' })
    expect(moduleTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Agente' })).toContainElement(panel)
    expect(screen.queryByRole('separator', { name: 'Redimensionar painel do agente' })).not.toBeInTheDocument()

    // Showing another module keeps the chat mounted, out of sight.
    fireEvent.click(screen.getByRole('tab', { name: 'Ambientes' }))
    expect(panel).toBeInTheDocument()
    expect(panel.closest('.agent-panel-wrapper')).toHaveAttribute('hidden')
    expect(screen.getByRole('button', { name: 'Mostrar painel do agente' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar painel do agente' }))
    expect(screen.getByRole('tabpanel', { name: 'Agente' })).toContainElement(panel)

    fireEvent.click(screen.getByRole('radio', { name: 'Direita' }))
    expect(screen.queryByRole('tab', { name: 'Agente' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Agente' })).toBe(panel)
    expect(panel.closest('.agent-panel-wrapper')).not.toHaveAttribute('hidden')
  })
})

describe('RequestWorkbench — feature flag do monitor de valores', () => {
  const sendGraphql = async () => {
    executeGraphqlRequest.mockResolvedValue({
      ok: true,
      value: {
        statusCode: 200,
        durationMs: 5,
        sizeBytes: 16,
        body: { kind: 'inline', body: '{"nome":"Ana"}' },
        bodyEncoding: 'text',
        requestHeaders: [],
        cookies: [],
        connection: { remoteAddress: null, httpVersion: '', tlsCertificatePresent: false, certificateVerificationDisabled: false },
        finalUrl: null,
        waitingMs: 0,
        environmentChanges: [],
        scriptLogs: [],
        scriptError: null,
        headers: [],
        graphqlErrors: [],
      },
    })
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('GraphQL')
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await findStatusText(/200/)
  }

  it('ligada, mostra o item Monitores na barra lateral e o botão Monitor na resposta', async () => {
    render()
    await sendGraphql()

    expect(screen.getByRole('tab', { name: 'Monitores' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Monitor' })).toBeInTheDocument()
    expect(listValueMonitors).toHaveBeenCalled()
  })

  it('desligada, não deixa nenhum vestígio na interface e não lê os monitores', async () => {
    featureFlags.valueMonitors = false
    render()
    await sendGraphql()

    expect(screen.queryByRole('tab', { name: 'Monitores' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Monitor' })).toBeNull()
    expect(document.querySelector('.rw-monitor-pill, .cm-monitor-pass, .cm-monitor-fail')).toBeNull()
    expect(listValueMonitors).not.toHaveBeenCalled()
  })
})

describe('RequestWorkbench — feature flag do git', () => {
  it('ligada, mostra a aba de controle de versão e o indicador Git na barra de status', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    expect(screen.getByRole('tab', { name: 'Controle de versão' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Controle de versão:/ })).toBeInTheDocument()
    expect(getWorkspaceLink).toHaveBeenCalled()
  })

  it('desligada, esconde a aba e o indicador e não consulta o vínculo do workspace', async () => {
    featureFlags.localGit = false
    render()
    await screen.findByLabelText('Ambiente')

    expect(screen.queryByRole('tab', { name: 'Controle de versão' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Controle de versão:/ })).toBeNull()
    expect(getWorkspaceLink).not.toHaveBeenCalled()
  })
})

describe('RequestWorkbench — extensões', () => {
  afterEach(() => {
    extensionState.sidebarModules.length = 0
    extensionState.readTabs = null
  })

  it('mostra o módulo da extensão na barra lateral e o painel dele', async () => {
    extensionState.sidebarModules.push({
      id: 'ext:fake',
      label: { 'pt-BR': 'Módulo falso', en: 'Fake module' },
      icon: <span />,
      Panel: () => <p>Painel falso</p>,
    })
    render()
    await screen.findByLabelText('Ambiente')

    fireEvent.click(screen.getByRole('tab', { name: 'Módulo falso' }))

    expect(screen.getByText('Painel falso')).toBeInTheDocument()
  })

  it('mostra a aba da extensão, recua quando outra aba abre e fecha pela barra', async () => {
    function useFakeTabs(): PseudoTab[] {
      const [open, setOpen] = useState(true)
      const [active, setActive] = useState(false)
      if (!open) return []
      return [{
        id: 'ext:fake-tab',
        label: 'Aba falsa',
        dirty: false,
        active,
        activate: () => setActive(true),
        deactivate: () => setActive(false),
        close: () => setOpen(false),
        content: <p>Conteúdo falso</p>,
      }]
    }
    extensionState.readTabs = useFakeTabs
    render()
    await screen.findByLabelText('Ambiente')

    fireEvent.click(screen.getByRole('tab', { name: 'Aba falsa' }))
    expect(screen.getByText('Conteúdo falso')).toBeInTheDocument()

    createRequestFromTabsBar('REST')
    await waitFor(() => expect(screen.queryByText('Conteúdo falso')).not.toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Aba falsa', selected: false })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Fechar aba Aba falsa' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Aba falsa' })).not.toBeInTheDocument())
  })
})

describe('RequestWorkbench — feature flag das notificações', () => {
  it('ligada, mostra o sino na barra de status', async () => {
    render()
    await screen.findByLabelText('Ambiente')

    expect(screen.getByRole('button', { name: /^Notificações/ })).toBeInTheDocument()
  })

  it('desligada, esconde o sino', async () => {
    featureFlags.notifications = false
    render()
    await screen.findByLabelText('Ambiente')

    expect(screen.queryByRole('button', { name: /^Notificações/ })).toBeNull()
  })
})

describe('RequestWorkbench — renderizações', () => {
  it('digitar no endpoint não renderiza a sidebar de novo', async () => {
    render()
    await screen.findByLabelText('Ambiente')
    createRequestFromTabsBar('REST')
    const endpoint = screen.getByLabelText('Endpoint')
    fireEvent.change(endpoint, { target: { value: 'https://api.test/a' } })
    // Allow effects of the first edit, including tab-session persistence, to settle.
    await act(async () => {})
    const before = sidebarRenders.count

    for (const value of ['https://api.test/ab', 'https://api.test/abc', 'https://api.test/abcd']) {
      fireEvent.change(endpoint, { target: { value } })
    }
    await act(async () => {})

    expect(endpoint).toHaveValue('https://api.test/abcd')
    expect(sidebarRenders.count).toBe(before)
  })
})
