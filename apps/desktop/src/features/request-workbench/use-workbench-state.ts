import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cancelGraphqlRequest } from '../../bindings/cancel-graphql-request'
import { executeGraphqlRequest } from '../../bindings/execute-graphql-request'
import { closeGrpcSend, executeGrpcRequest, sendGrpcMessage } from '../../bindings/execute-grpc-request'
import { appendGrpcEvent, emptyGrpcStream } from './grpc-stream'
import { executeRestRequest } from '../../bindings/execute-rest-request'
import type { HttpMethodInput, RawBodyLanguage } from '../../bindings/execute-rest-request'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { loadGrpcSchema as loadGrpcSchemaBinding } from '../../bindings/load-grpc-schema'
import { loadSchema as loadSchemaBinding } from '../../bindings/load-schema'
import { releaseResponseBody } from '../../bindings/release-response-body'
import { matchExistingRows, type BulkRow } from '../../shared/bulk-edit'
import type { DropEdge } from '../../shared/use-pointer-drag'
import {
  contentTypeFor,
  emptyBodyState,
  emptyFormDataEntry,
  emptyUrlEncodedEntry,
  sameRestBody,
  syncContentTypeHeader,
  toBodyState,
  toRestBodyInput,
} from './body-state'
import { emptyGrpcCall, emptyRequestContent, mergeScopedVariables, sameGrpcCall, variableScopesFor } from './collection-tree'
import {
  emptyAuthorizationState,
  sameAuthentication,
  toAuthenticationInput,
  toAuthorizationState,
} from './authorization-state'
import type { GrpcCallState, RequestContent, RequestProtocol, TreeNode } from './collection-tree'
import { createEmptyQuery, ensureFieldPath, parseQuery, setFieldArgument, toggleField } from './graphql-query-tree'
import {
  buildUrlWithParams,
  normalizeRouteParamName,
  parseQueryParams,
  parseRouteParams,
  removeRouteParamFromUrl,
  renameRouteParamInUrl,
} from './query-params'
import type {
  AuthorizationState,
  BodyState,
  BodyType,
  ExecutionState,
  FlowNodeRef,
  FormDataEntry,
  HeaderEntry,
  ParamEntry,
  RequestTabId,
  RouteParamEntry,
  UrlEncodedEntry,
  WorkbenchTab,
} from './request-workbench.types'
import type { RestoredTab } from './tab-session'
import { internSchema } from './schema-registry'
import { renameNodeReferences } from '../flows/node-identifiers'

/** Release a windowed body once no tab references it (spec 0020). Best effort: the backend cache also enforces a memory limit. */
function releaseIfWindowed(execution: ExecutionState) {
  if (execution.status === 'success' && execution.result.body.kind === 'windowed') {
    void releaseResponseBody(execution.result.body.handle)
  }
}

/** Closing a tab also stops an interactive gRPC call that could otherwise stay open indefinitely. */
function disposeTab(tab: WorkbenchTab) {
  if (tab.protocol === 'grpc' && tab.executionId) void cancelGraphqlRequest(tab.executionId)
  releaseIfWindowed(tab.execution)
}

let headerIdSequence = 0
const nextHeaderId = () => `header-${++headerIdSequence}`

let paramIdSequence = 0
const nextParamId = () => `param-${++paramIdSequence}`

let routeParamIdSequence = 0
const nextRouteParamId = () => `route-param-${++routeParamIdSequence}`

/** Rebuild Params from the URL query whenever the endpoint is edited or a tab is opened. */
function paramsFromUrl(url: string): ParamEntry[] {
  return parseQueryParams(url).map(({ name, value }) => ({ id: nextParamId(), name, value, enabled: true }))
}

/** Derive route parameters from the URL, preserving values for names that remain after editing. */
function routeParamsFromUrl(
  url: string,
  current: ReadonlyArray<{ id?: string; name: string; value: string }> = [],
): RouteParamEntry[] {
  return parseRouteParams(url).map(({ name }) => {
    const existing = current.find((param) => param.name === name)
    return { id: existing?.id ?? nextRouteParamId(), name, value: existing?.value ?? '' }
  })
}

function createTab(overrides: Partial<WorkbenchTab> = {}): WorkbenchTab {
  const endpointUrl = overrides.endpointUrl ?? ''
  return {
    id: crypto.randomUUID(),
    requestId: null,
    name: '',
    pinned: true,
    endpointUrl,
    activeSection: 'query',
    protocol: 'graphql',
    method: 'post',
    query: '',
    variables: '{}',
    body: emptyBodyState,
    preRequestScript: '',
    postResponseScript: '',
    headers: [],
    params: paramsFromUrl(endpointUrl),
    routeParams: routeParamsFromUrl(endpointUrl),
    authorization: { ...emptyAuthorizationState, type: 'inherit' },
    savedContent: emptyRequestContent('graphql'),
    dirty: false,
    execution: { status: 'idle' },
    executionId: null,
    lastSendId: null,
    schema: { status: 'idle' },
    schemaExecutionId: null,
    grpc: emptyGrpcCall,
    grpcSchema: { status: 'idle' },
    ...overrides,
  }
}

/** First section of a freshly opened tab, per protocol. */
function firstSectionOf(protocol: RequestProtocol): RequestTabId {
  switch (protocol) {
    case 'rest':
      return 'params'
    case 'grpc':
      return 'message'
    case 'graphql':
      return 'query'
  }
}

function tabFromContent(requestId: string | null, name: string, content: RequestContent): WorkbenchTab {
  return createTab({
    requestId,
    name,
    protocol: content.protocol,
    // The default query section exists only in GraphQL; reopened tabs use
    // the section for their protocol, including history and session restoration.
    activeSection: firstSectionOf(content.protocol),
    endpointUrl: content.endpointUrl,
    query: content.query,
    variables: content.variables,
    method: content.method,
    body: toBodyState(content.body),
    preRequestScript: content.preRequestScript,
    postResponseScript: content.postResponseScript,
    headers: content.headers.map((header) => ({ id: nextHeaderId(), ...header })),
    params: paramsFromUrl(content.endpointUrl),
    routeParams: routeParamsFromUrl(content.endpointUrl, content.routeParams),
    authorization: toAuthorizationState(content.authentication),
    grpc: content.grpc,
    savedContent: content,
    dirty: requestId === null,
  })
}

/** Savable tab content, also stored as the draft in the tab session. */
export function contentOf(tab: WorkbenchTab): RequestContent {
  return {
    protocol: tab.protocol,
    endpointUrl: tab.endpointUrl,
    query: tab.query,
    variables: tab.variables,
    method: tab.method,
    body: toRestBodyInput(tab.body),
    headers: tab.headers.map((header) => ({ name: header.name, value: header.value, enabled: header.enabled })),
    routeParams: tab.routeParams.map(({ name, value }) => ({ name, value })),
    authentication: toAuthenticationInput(tab.authorization),
    preRequestScript: tab.preRequestScript,
    postResponseScript: tab.postResponseScript,
    grpc: tab.grpc,
  }
}

function sameHeaders(a: HeaderEntry[], b: { name: string; value: string; enabled: boolean }[]): boolean {
  if (a.length !== b.length) return false
  return a.every((header, index) => {
    const other = b[index]
    return header.name === other.name && header.value === other.value && header.enabled === other.enabled
  })
}

function sameRouteParams(a: RouteParamEntry[], b: { name: string; value: string }[]): boolean {
  if (a.length !== b.length) return false
  return a.every((param, index) => param.name === b[index]?.name && param.value === b[index]?.value)
}

/** Compare edits with the saved snapshot to compute dirty state and pin edited preview tabs. */
function contentDiffersFromSaved(tab: WorkbenchTab): boolean {
  const saved = tab.savedContent
  return (
    tab.endpointUrl !== saved.endpointUrl ||
    tab.query !== saved.query ||
    tab.variables !== saved.variables ||
    tab.method !== saved.method ||
    !sameRestBody(toRestBodyInput(tab.body), saved.body) ||
    tab.preRequestScript !== saved.preRequestScript ||
    tab.postResponseScript !== saved.postResponseScript ||
    !sameHeaders(tab.headers, saved.headers) ||
    !sameRouteParams(tab.routeParams, saved.routeParams) ||
    !sameAuthentication(toAuthenticationInput(tab.authorization), saved.authentication) ||
    !sameGrpcCall(tab.grpc, saved.grpc)
  )
}

function computeDirty(tab: WorkbenchTab): boolean {
  return (tab.requestId === null && !tab.flowNodeRef) || contentDiffersFromSaved(tab)
}

/** Whether the tab changed since loading or saving, for the OpenTabsBar indicator. */
export function isTabDirty(tab: WorkbenchTab): boolean {
  return tab.dirty
}

type TabPatch = Partial<WorkbenchTab> | ((tab: WorkbenchTab) => Partial<WorkbenchTab>)

/** An idle-screen fallback, never inserted into state.tabs. No visible editor reads these fields. */
const EMPTY_TAB: WorkbenchTab = createTab()

/** Environment variables are overlaid by collection/folder scopes (ADR 0031), sent in layers to Rust and merged for display. */
export function useWorkbenchState(environmentVariables: EnvironmentVariableDto[], rootPath: string, collections: TreeNode[]) {
  const [state, setState] = useState<{ tabs: WorkbenchTab[]; activeTabId: string | null }>({
    tabs: [],
    activeTabId: null,
  })
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  /** Cancel active interactive calls when the workbench unmounts. */
  useEffect(() => () => stateRef.current.tabs.forEach(disposeTab), [])

  const autoSchemaLoadedTabsRef = useRef<Set<string>>(new Set())

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? EMPTY_TAB
  const effectiveVariables = useMemo(
    () => mergeScopedVariables(environmentVariables, collections, activeTab.requestId),
    [environmentVariables, collections, activeTab.requestId],
  )

  const updateTab = useCallback((tabId: string | null, patch: TabPatch) => {
    setState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const merged = { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) }
        const dirty = computeDirty(merged)
        return { ...merged, dirty, pinned: merged.pinned || contentDiffersFromSaved(merged) }
      }),
    }))
  }, [])

  const updateActiveTab = useCallback(
    (patch: TabPatch) => {
      updateTab(state.activeTabId, patch)
    },
    [state.activeTabId, updateTab],
  )

  /** ignoreResponseSizeLimit applies only to this resend. */
  const send = useCallback(async (options?: { ignoreResponseSizeLimit?: boolean }) => {
    const ignoreResponseSizeLimit = options?.ignoreResponseSizeLimit === true
    const tabId = state.activeTabId
    const tab = activeTab
    releaseIfWindowed(tab.execution)
    const id = crypto.randomUUID()
    // Sending pins the tab before awaiting so another sidebar request cannot
    // replace its content while the execution is running or after it finishes.
    // The response remains associated with the tab that initiated the request.
    updateTab(tabId, { pinned: true, executionId: id, execution: { status: 'loading', startedAt: Date.now() } })

    const headers = tab.headers.map((header) => ({ name: header.name, value: header.value, enabled: header.enabled }))
    const authentication = toAuthenticationInput(tab.authorization)
    const environmentVariablesInput = environmentVariables.map(({ name, value, sensitive }) => ({ name, value, sensitive }))
    const variableScopes = variableScopesFor(collections, tab.requestId)

    const result =
      tab.protocol === 'rest'
        ? await executeRestRequest({
            executionId: id,
            rootPath,
            endpointUrl: tab.endpointUrl,
            routeParams: tab.routeParams.map(({ name, value }) => ({ name, value })),
            method: tab.method,
            body: toRestBodyInput(tab.body),
            headers,
            authentication,
            requestId: tab.requestId,
            tabId,
            environmentVariables: environmentVariablesInput,
            variableScopes,
            preRequestScript: tab.preRequestScript,
            postResponseScript: tab.postResponseScript,
            ignoreResponseSizeLimit,
          })
        : await executeGraphqlRequest({
            executionId: id,
            rootPath,
            endpointUrl: tab.endpointUrl,
            query: tab.query,
            variables: tab.variables,
            headers,
            authentication,
            requestId: tab.requestId,
            tabId,
            environmentVariables: environmentVariablesInput,
            variableScopes,
            preRequestScript: tab.preRequestScript,
            postResponseScript: tab.postResponseScript,
            ignoreResponseSizeLimit,
          })

    updateTab(tabId, {
      executionId: null,
      lastSendId: id,
      execution: result.ok ? { status: 'success', result: result.value } : { status: 'error', error: result.error },
    })

    return result
  }, [state.activeTabId, activeTab, environmentVariables, collections, rootPath, updateTab])

  /** Calls the active gRPC tab's method (spec 0129). */
  const sendGrpc = useCallback(async () => {
    const tabId = state.activeTabId
    const tab = activeTab
    releaseIfWindowed(tab.execution)
    const id = crypto.randomUUID()
    const startedAt = Date.now()
    updateTab(tabId, { pinned: true, executionId: id, lastSendId: id, execution: { status: 'loading', startedAt }, grpcStream: { ...emptyGrpcStream, startedAt } })

    const result = await executeGrpcRequest({
      executionId: id,
      preRequestScript: tab.preRequestScript,
      postResponseScript: tab.postResponseScript,
      rootPath,
      endpoint: tab.endpointUrl,
      schemaSource: tab.grpc.schemaSource,
      service: tab.grpc.service,
      method: tab.grpc.method,
      deadlineMs: tab.grpc.deadlineMs,
      message: tab.grpc.message,
      headers: tab.headers.map((header) => ({ name: header.name, value: header.value, enabled: header.enabled })),
      authentication: toAuthenticationInput(tab.authorization),
      requestId: tab.requestId,
      tabId,
      environmentVariables: environmentVariables.map(({ name, value, sensitive }) => ({ name, value, sensitive })),
      variableScopes: variableScopesFor(collections, tab.requestId),
    }, (event) => {
      updateTab(tabId, (current) => current.executionId === id
        ? { grpcStream: appendGrpcEvent(current.grpcStream ?? emptyGrpcStream, event) }
        : {})
    })

    updateTab(tabId, (current) => current.executionId !== id ? {} : {
      grpcStream: { ...(current.grpcStream ?? emptyGrpcStream), accepting: false, busy: false },
      executionId: null,
      lastSendId: id,
      execution: result.ok ? { status: 'success', result: result.value } : { status: 'error', error: result.error },
    })
    return result
  }, [state.activeTabId, activeTab, environmentVariables, collections, rootPath, updateTab])

  const controlGrpcStream = useCallback(async (close: boolean) => {
    const tabId = state.activeTabId
    const id = activeTab.executionId
    if (!id || !activeTab.grpcStream?.accepting || activeTab.grpcStream.busy) return
    updateTab(tabId, (tab) => ({ grpcStream: { ...(tab.grpcStream ?? emptyGrpcStream), busy: true, error: null } }))
    const result = close ? await closeGrpcSend(id) : await sendGrpcMessage(id, activeTab.grpc.message, environmentVariables, variableScopesFor(collections, activeTab.requestId))
    updateTab(tabId, (tab) => tab.executionId !== id ? {} : {
      grpcStream: {
        ...(tab.grpcStream ?? emptyGrpcStream),
        busy: false,
        accepting: result.ok && close ? false : (tab.grpcStream?.accepting ?? false),
        error: result.ok ? null : result.error,
      },
    })
  }, [state.activeTabId, activeTab.executionId, activeTab.grpcStream, activeTab.grpc.message, activeTab.requestId, environmentVariables, collections, updateTab])

  const cancel = useCallback(() => {
    if (activeTab.executionId) {
      void cancelGraphqlRequest(activeTab.executionId)
    }
  }, [activeTab.executionId])

  const clearResponse = useCallback(() => {
    if (activeTab.executionId) void cancelGraphqlRequest(activeTab.executionId)
    releaseIfWindowed(activeTab.execution)
    updateTab(state.activeTabId, { executionId: null, lastSendId: null, execution: { status: 'idle' }, grpcStream: undefined })
  }, [state.activeTabId, activeTab.execution, activeTab.executionId, updateTab])

  const loadSchema = useCallback(
    async (forceRefresh: boolean) => {
      const tabId = state.activeTabId
      const tab = activeTab
      const id = crypto.randomUUID()
      updateTab(tabId, { schemaExecutionId: id, schema: { status: 'loading' } })

      const result = await loadSchemaBinding({
        executionId: id,
        endpointUrl: tab.endpointUrl,
        headers: tab.headers.map((header) => ({ name: header.name, value: header.value, enabled: header.enabled })),
        authentication: toAuthenticationInput(tab.authorization),
        rootPath,
        requestId: tab.requestId,
        environmentVariables: environmentVariables.map(({ name, value, sensitive }) => ({ name, value, sensitive })),
        variableScopes: variableScopesFor(collections, tab.requestId),
        forceRefresh,
      })

      updateTab(tabId, {
        schemaExecutionId: null,
        // Tabs at the same endpoint share one schema instance.
        schema: result.ok ? { status: 'success', schema: internSchema(result.value) } : { status: 'error', error: result.error },
      })
    },
    [state.activeTabId, activeTab, environmentVariables, collections, rootPath, updateTab],
  )

  const cancelSchemaLoad = useCallback(() => {
    if (activeTab.schemaExecutionId) {
      void cancelGraphqlRequest(activeTab.schemaExecutionId)
    }
  }, [activeTab.schemaExecutionId])

  /** Services and methods of the active gRPC tab's server (spec 0129). */
  const loadGrpcSchema = useCallback(
    async (forceRefresh: boolean) => {
      const tabId = state.activeTabId
      const tab = activeTab
      const id = crypto.randomUUID()
      updateTab(tabId, { schemaExecutionId: id, grpcSchema: { status: 'loading' } })

      const result = await loadGrpcSchemaBinding({
        executionId: id,
        rootPath,
        endpoint: tab.endpointUrl,
        schemaSource: tab.grpc.schemaSource,
        headers: tab.headers.map((header) => ({ name: header.name, value: header.value, enabled: header.enabled })),
        authentication: toAuthenticationInput(tab.authorization),
        requestId: tab.requestId,
        environmentVariables: environmentVariables.map(({ name, value, sensitive }) => ({ name, value, sensitive })),
        variableScopes: variableScopesFor(collections, tab.requestId),
        forceRefresh,
      })

      updateTab(tabId, (current) => current.schemaExecutionId !== id ? {} : {
        schemaExecutionId: null,
        grpcSchema: result.ok ? { status: 'success', schema: result.value } : { status: 'error', error: result.error },
      })
    },
    [state.activeTabId, activeTab, environmentVariables, collections, rootPath, updateTab],
  )

  const updateGrpc = useCallback(
    (patch: Partial<GrpcCallState>) => updateActiveTab((tab) => ({
      grpc: { ...tab.grpc, ...patch },
      ...(patch.schemaSource ? { grpcSchema: { status: 'idle' }, schemaExecutionId: null } as const : {}),
    })),
    [updateActiveTab],
  )

  /** Load the schema once for each saved GraphQL tab, using the disk cache when possible. Draft endpoints still require explicit loading. Reopening creates a new tab ID and can load again. */
  useEffect(() => {
    const tab = activeTab
    if (
      tab.protocol !== 'graphql' ||
      tab.requestId === null ||
      tab.endpointUrl.trim().length === 0 ||
      tab.schema.status !== 'idle' ||
      autoSchemaLoadedTabsRef.current.has(tab.id)
    ) {
      return
    }
    autoSchemaLoadedTabsRef.current.add(tab.id)
    void loadSchema(false)
  }, [activeTab, loadSchema])

  const toggleQueryField = useCallback(
    (path: string[], fieldName: string, hasSubfields: boolean) => {
      const parsed = parseQuery(activeTab.query) ?? createEmptyQuery()
      const ensured = ensureFieldPath(parsed, path)
      updateActiveTab({ query: toggleField(ensured, path, fieldName, hasSubfields) })
    },
    [activeTab.query, updateActiveTab],
  )

  const setQueryFieldArgument = useCallback(
    (path: string[], fieldName: string, hasSubfields: boolean, argName: string, literal: string | null) => {
      const parsed = parseQuery(activeTab.query) ?? createEmptyQuery()
      updateActiveTab({ query: setFieldArgument(parsed, path, fieldName, hasSubfields, argName, literal) })
    },
    [activeTab.query, updateActiveTab],
  )

  const addHeader = useCallback(() => {
    updateActiveTab((tab) => ({ headers: [...tab.headers, { id: nextHeaderId(), name: '', value: '', enabled: true }] }))
  }, [updateActiveTab])

  const updateHeader = useCallback(
    (id: string, patch: Partial<Omit<HeaderEntry, 'id'>>) => {
      updateActiveTab((tab) => ({ headers: tab.headers.map((header) => (header.id === id ? { ...header, ...patch } : header)) }))
    },
    [updateActiveTab],
  )

  const removeHeader = useCallback(
    (id: string) => {
      updateActiveTab((tab) => ({ headers: tab.headers.filter((header) => header.id !== id) }))
    },
    [updateActiveTab],
  )

  const replaceHeaders = useCallback(
    (rows: BulkRow[]) => {
      updateActiveTab((tab) => {
        const matches = matchExistingRows(tab.headers, rows)
        return { headers: rows.map((row, index) => ({ id: matches[index]?.id ?? nextHeaderId(), ...row })) }
      })
    },
    [updateActiveTab],
  )

  const addParam = useCallback(() => {
    updateActiveTab((tab) => {
      const params = [...tab.params, { id: nextParamId(), name: '', value: '', enabled: true }]
      return { params, endpointUrl: buildUrlWithParams(tab.endpointUrl, params) }
    })
  }, [updateActiveTab])

  const updateParam = useCallback(
    (id: string, patch: Partial<Omit<ParamEntry, 'id'>>) => {
      updateActiveTab((tab) => {
        const params = tab.params.map((param) => (param.id === id ? { ...param, ...patch } : param))
        return { params, endpointUrl: buildUrlWithParams(tab.endpointUrl, params) }
      })
    },
    [updateActiveTab],
  )

  const removeParam = useCallback(
    (id: string) => {
      updateActiveTab((tab) => {
        const params = tab.params.filter((param) => param.id !== id)
        return { params, endpointUrl: buildUrlWithParams(tab.endpointUrl, params) }
      })
    },
    [updateActiveTab],
  )

  const replaceParams = useCallback(
    (rows: BulkRow[]) => {
      updateActiveTab((tab) => {
        const matches = matchExistingRows(tab.params, rows)
        const params = rows.map((row, index) => ({ id: matches[index]?.id ?? nextParamId(), ...row }))
        return { params, endpointUrl: buildUrlWithParams(tab.endpointUrl, params) }
      })
    },
    [updateActiveTab],
  )

  const updateRouteParam = useCallback(
    (id: string, value: string) => {
      updateActiveTab((tab) => ({
        routeParams: tab.routeParams.map((param) => (param.id === id ? { ...param, value } : param)),
      }))
    },
    [updateActiveTab],
  )

  const updateRouteParamName = useCallback(
    (id: string, name: string) => {
      updateActiveTab((tab) => {
        const routeParam = tab.routeParams.find((param) => param.id === id)
        if (!routeParam) return {}
        const normalizedName = normalizeRouteParamName(name)
        const endpointUrl = renameRouteParamInUrl(tab.endpointUrl, routeParam.name, normalizedName)
        const updated = { ...routeParam, name: normalizedName }
        return {
          endpointUrl,
          routeParams: routeParamsFromUrl(endpointUrl, [updated, ...tab.routeParams.filter((param) => param.id !== id)]),
        }
      })
    },
    [updateActiveTab],
  )

  const removeRouteParam = useCallback(
    (id: string) => {
      updateActiveTab((tab) => {
        const removed = tab.routeParams.find((param) => param.id === id)
        if (!removed) return {}
        const endpointUrl = removeRouteParamFromUrl(tab.endpointUrl, removed.name)
        return {
          endpointUrl,
          routeParams: routeParamsFromUrl(endpointUrl, tab.routeParams),
        }
      })
    },
    [updateActiveTab],
  )

  const updateAuthorization = useCallback(
    (patch: Partial<AuthorizationState>) => {
      updateActiveTab((tab) => ({ authorization: { ...tab.authorization, ...patch } }))
    },
    [updateActiveTab],
  )

  const openRequest = useCallback(
    (requestId: string, content: RequestContent, name: string, activate = true, preview = true) => {
      const snapshot = stateRef.current
      const existing = snapshot.tabs.find((tab) => tab.requestId === requestId)
      if (!existing && preview) {
        const replacedPreview = snapshot.tabs.find((candidate) => !candidate.pinned)
        if (replacedPreview) releaseIfWindowed(replacedPreview.execution)
      }

      setState((current) => {
        const existing = current.tabs.find((tab) => tab.requestId === requestId)
        if (existing) return activate ? { ...current, activeTabId: existing.id } : current

        const tab = { ...tabFromContent(requestId, name, content), pinned: !preview }
        const previewIndex = preview ? current.tabs.findIndex((candidate) => !candidate.pinned) : -1
        if (previewIndex !== -1) {
          const tabs = [...current.tabs]
          tabs[previewIndex] = tab
          return activate ? { tabs, activeTabId: tab.id } : { ...current, tabs }
        }

        const tabs = [...current.tabs, tab]
        return activate ? { tabs, activeTabId: tab.id } : { ...current, tabs }
      })
    },
    [],
  )

  /** Open a history entry as an editable preview that another request can replace until pinned. */
  const openHistoryEntry = useCallback(
    (historyId: string, name: string, content: RequestContent, execution: ExecutionState) => {
      const tabId = `history:${historyId}`
      const snapshot = stateRef.current
      const existing = snapshot.tabs.find((tab) => tab.id === tabId)
      if (!existing) {
        const replacedPreview = snapshot.tabs.find((candidate) => !candidate.pinned)
        if (replacedPreview) releaseIfWindowed(replacedPreview.execution)
      }

      setState((current) => {
        const existing = current.tabs.find((tab) => tab.id === tabId)
        if (existing) return { ...current, activeTabId: existing.id }

        const tab = { ...tabFromContent(null, name, content), id: tabId, pinned: false, execution }
        const previewIndex = current.tabs.findIndex((candidate) => !candidate.pinned)
        if (previewIndex !== -1) {
          const tabs = [...current.tabs]
          tabs[previewIndex] = tab
          return { tabs, activeTabId: tab.id }
        }

        return { tabs: [...current.tabs, tab], activeTabId: tab.id }
      })
    },
    [],
  )

  /** Restore the saved tab session (ADR 0039), retaining IDs for send history and comparing savedContent for dirty state. */
  const restoreTabs = useCallback((restored: RestoredTab[], activeTabId: string | null) => {
    setState(() => {
      const tabs = restored.map((entry) => {
        const tab = {
          ...tabFromContent(entry.requestId, entry.name, entry.content),
          id: entry.id,
          savedContent: entry.savedContent,
          pinned: true,
          fixed: entry.fixed,
        }
        return { ...tab, dirty: computeDirty(tab) }
      })
      const active = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null)
      return { tabs, activeTabId: active }
    })
  }, [])

  /** Open a blank standalone draft with no requestId. */
  const newDraftTab = useCallback((protocol: RequestProtocol, name = '') => {
    setState((current) => {
      const tab = tabFromContent(null, name, emptyRequestContent(protocol))
      return { tabs: [...current.tabs, tab], activeTabId: tab.id }
    })
  }, [])

  /** Open or activate an inline flow request tab. It has no requestId but starts without pending edits. */
  const openFlowNodeRequest = useCallback((ref: FlowNodeRef, name: string, content: RequestContent) => {
    setState((current) => {
      const existing = current.tabs.find(
        (tab) => tab.flowNodeRef?.flowId === ref.flowId && tab.flowNodeRef.nodeId === ref.nodeId,
      )
      if (existing) return { ...current, activeTabId: existing.id }
      const tab = { ...tabFromContent(null, name, content), flowNodeRef: ref, dirty: false, pinned: true }
      return { tabs: [...current.tabs, tab], activeTabId: tab.id }
    })
  }, [])

  /** Open prepared content as an unsaved standalone draft. */
  const openDraft = useCallback((name: string, content: RequestContent) => {
    setState((current) => {
      const tab = tabFromContent(null, name, content)
      return { tabs: [...current.tabs, tab], activeTabId: tab.id }
    })
  }, [])

  /** Flow inspectors edit the same draft as request tabs without activating a tab. */
  const editFlowRequestDraft = useCallback((request: { id: string; name: string; content: RequestContent }, content: RequestContent, flowNodeRef?: FlowNodeRef) => {
    setState((current) => {
      const existing = current.tabs.find((tab) => flowNodeRef
        ? tab.flowNodeRef?.flowId === flowNodeRef.flowId && tab.flowNodeRef.nodeId === flowNodeRef.nodeId
        : tab.requestId === request.id)
      const base = existing ?? { ...tabFromContent(flowNodeRef ? null : request.id, request.name, request.content), flowNodeRef, pinned: true }
      const next = tabFromContent(base.requestId, base.name, content)
      const updated = { ...base, protocol: next.protocol, endpointUrl: next.endpointUrl, query: next.query, variables: next.variables, method: next.method, body: next.body, headers: next.headers, params: next.params, routeParams: next.routeParams, authorization: next.authorization, grpc: next.grpc, preRequestScript: next.preRequestScript, postResponseScript: next.postResponseScript, pinned: true }
      updated.dirty = computeDirty(updated)
      return { ...current, tabs: existing ? current.tabs.map((tab) => tab.id === existing.id ? updated : tab) : [...current.tabs, updated] }
    })
  }, [])

  const selectTab = useCallback((tabId: string) => {
    setState((current) => ({ ...current, activeTabId: tabId }))
  }, [])

  /** Keep inline tabs attached and preserve their dirty state when graph references change. */
  const renameFlowNode = useCallback((flowId: string, previous: string, next: string) => {
    setState((current) => ({ ...current, tabs: current.tabs.map((tab) => {
      if (tab.flowNodeRef?.flowId !== flowId) return tab
      const content = renameNodeReferences(contentOf(tab), previous, next)
      const restored = tabFromContent(null, tab.name, content)
      const updated = { ...tab, protocol: restored.protocol, endpointUrl: restored.endpointUrl, query: restored.query, variables: restored.variables, method: restored.method, body: restored.body, headers: restored.headers, params: restored.params, routeParams: restored.routeParams, authorization: restored.authorization, grpc: restored.grpc, preRequestScript: restored.preRequestScript, postResponseScript: restored.postResponseScript, savedContent: renameNodeReferences(tab.savedContent, previous, next), flowNodeRef: { flowId, nodeId: tab.flowNodeRef.nodeId === previous ? next : tab.flowNodeRef.nodeId } }
      updated.dirty = computeDirty(updated)
      return updated
    }) }))
  }, [])

  const pinTab = useCallback(
    (tabId: string) => {
      updateTab(tabId, { pinned: true })
    },
    [updateTab],
  )

  /** Toggle a fixed tab; fixing also ends preview mode. */
  const toggleFixTab = useCallback(
    (tabId: string) => {
      updateTab(tabId, (tab) => (tab.fixed ? { fixed: false } : { fixed: true, pinned: true }))
    },
    [updateTab],
  )

  /** Pin an open saved request tab, ending preview mode. */
  const pinRequest = useCallback(
    (requestId: string) => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.requestId === requestId)
      if (tab && !tab.pinned) updateTab(tab.id, { pinned: true })
    },
    [updateTab],
  )

  const closePreviewTab = useCallback(() => {
    const preview = stateRef.current.tabs.find((tab) => !tab.pinned)
    if (preview) releaseIfWindowed(preview.execution)

    setState((current) => {
      const previewIndex = current.tabs.findIndex((tab) => !tab.pinned)
      if (previewIndex === -1) return current

      const previewTab = current.tabs[previewIndex]
      const tabs = current.tabs.filter((tab) => tab.id !== previewTab.id)
      if (current.activeTabId !== previewTab.id) return { ...current, tabs }
      return { tabs, activeTabId: tabs[Math.min(previewIndex, tabs.length - 1)]?.id ?? null }
    })
  }, [])

  /** Move draggedId before or after targetId in OpenTabsBar. */
  const reorderTabs = useCallback((draggedId: string, targetId: string, edge: DropEdge) => {
    if (draggedId === targetId) return

    setState((current) => {
      const fromIndex = current.tabs.findIndex((tab) => tab.id === draggedId)
      const toIndex = current.tabs.findIndex((tab) => tab.id === targetId)
      if (fromIndex === -1 || toIndex === -1) return current

      const tabs = [...current.tabs]
      const [dragged] = tabs.splice(fromIndex, 1)
      const adjustedTargetIndex = tabs.findIndex((tab) => tab.id === targetId)
      const insertIndex = edge === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex
      tabs.splice(insertIndex, 0, dragged)
      return { ...current, tabs }
    })
  }, [])

  /** Move the ordered group of IDs before or after targetId. */
  const reorderTabsGroup = useCallback((ids: readonly string[], targetId: string, edge: DropEdge) => {
    if (ids.includes(targetId)) return

    setState((current) => {
      const moved = current.tabs.filter((tab) => ids.includes(tab.id))
      if (moved.length === 0 || !current.tabs.some((tab) => tab.id === targetId)) return current

      const tabs = current.tabs.filter((tab) => !ids.includes(tab.id))
      const targetIndex = tabs.findIndex((tab) => tab.id === targetId)
      tabs.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, ...moved)
      return { ...current, tabs }
    })
  }, [])

  const closeTab = useCallback(
    (tabId: string) => {
      const closing = stateRef.current.tabs.find((tab) => tab.id === tabId)
      if (closing) disposeTab(closing)
      autoSchemaLoadedTabsRef.current.delete(tabId)

      setState((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === tabId)
        if (index === -1) return current

        const remaining = current.tabs.filter((tab) => tab.id !== tabId)
        if (remaining.length === 0) return { tabs: [], activeTabId: null }
        if (current.activeTabId !== tabId) return { ...current, tabs: remaining }

        const nextActive = remaining[Math.min(index, remaining.length - 1)]
        return { tabs: remaining, activeTabId: nextActive.id }
      })
    },
    [],
  )

  const closeAllTabs = useCallback(() => {
    stateRef.current.tabs.forEach(disposeTab)
    autoSchemaLoadedTabsRef.current.clear()
    setState({ tabs: [], activeTabId: null })
  }, [])

  /** Close every tab except tabId. */
  const closeOtherTabs = useCallback(
    (tabId: string) => {
      stateRef.current.tabs
        .filter((tab) => tab.id !== tabId)
        .forEach((tab) => {
          disposeTab(tab)
          autoSchemaLoadedTabsRef.current.delete(tab.id)
        })

      setState((current) => {
        const kept = current.tabs.find((tab) => tab.id === tabId)
        if (!kept) return current
        return { tabs: [kept], activeTabId: tabId }
      })
    },
    [],
  )

  /** Close matching tabs and activate the first remaining tab if the active tab closes. */
  const closeTabsWhere = useCallback(
    (shouldClose: (tabId: string) => boolean) => {
      stateRef.current.tabs
        .filter((tab) => shouldClose(tab.id))
        .forEach((tab) => {
          disposeTab(tab)
          autoSchemaLoadedTabsRef.current.delete(tab.id)
        })

      setState((current) => {
        const kept = current.tabs.filter((tab) => !shouldClose(tab.id))
        if (kept.length === current.tabs.length) return current
        const active = kept.some((tab) => tab.id === current.activeTabId) ? current.activeTabId : (kept[0]?.id ?? null)
        return { tabs: kept, activeTabId: active }
      })
    },
    [],
  )

  const markSaved = useCallback(
    (tabId: string, requestId: string, name: string) => {
      updateTab(tabId, (tab) => ({ requestId, name, savedContent: contentOf(tab), pinned: true }))
    },
    [updateTab],
  )

  /** Mark current tab content as saved after updating an existing request. */
  const markContentSaved = useCallback(
    (tabId: string, snapshot?: RequestContent) => {
      updateTab(tabId, (tab) => ({ savedContent: snapshot ?? contentOf(tab) }))
    },
    [updateTab],
  )

  const renameTab = useCallback(
    (tabId: string, name: string) => {
      updateTab(tabId, { name })
    },
    [updateTab],
  )

  /** Detach a removed saved request into a dirty draft so Save cannot write to a missing item. */
  const detachRequest = useCallback(
    (tabId: string) => {
      updateTab(tabId, { requestId: null, flowNodeRef: undefined, pinned: true })
    },
    [updateTab],
  )

  /** Savable content for any tab, including context-menu saves on inactive tabs. */
  const contentOfTab = useCallback(
    (tabId: string): RequestContent => contentOf(state.tabs.find((tab) => tab.id === tabId) ?? activeTab),
    [state.tabs, activeTab],
  )

  /** Replace tab content while preserving identity and the saved snapshot for dirty checks. Change the section only when the protocol changes. */
  const replaceTabContent = useCallback(
    (tabId: string, content: RequestContent) =>
      updateTab(tabId, (tab) => {
        const next = tabFromContent(tab.requestId, tab.name, content)
        return {
          protocol: next.protocol,
          activeSection: next.protocol === tab.protocol ? tab.activeSection : next.activeSection,
          endpointUrl: next.endpointUrl,
          query: next.query,
          variables: next.variables,
          method: next.method,
          body: next.body,
          preRequestScript: next.preRequestScript,
          postResponseScript: next.postResponseScript,
          headers: next.headers,
          params: next.params,
          routeParams: next.routeParams,
          authorization: next.authorization,
          grpc: next.grpc,
          grpcSchema: { status: 'idle' },
          schemaExecutionId: null,
        }
      }),
    [updateTab],
  )

  const setEndpointUrl = useCallback(
    (value: string) =>
      updateActiveTab((tab) => ({
        endpointUrl: value,
        ...(tab.protocol === 'grpc' && tab.endpointUrl !== value
          ? { grpcSchema: { status: 'idle' }, schemaExecutionId: null } as const : {}),
        params: paramsFromUrl(value),
        routeParams: routeParamsFromUrl(value, tab.routeParams),
      })),
    [updateActiveTab],
  )
  const setActiveSection = useCallback((value: RequestTabId) => updateActiveTab({ activeSection: value }), [updateActiveTab])
  const setQuery = useCallback((value: string) => updateActiveTab({ query: value }), [updateActiveTab])
  const setVariables = useCallback((value: string) => updateActiveTab({ variables: value }), [updateActiveTab])
  const setMethod = useCallback((value: HttpMethodInput) => updateActiveTab({ method: value }), [updateActiveTab])
  const updateBody = useCallback(
    (patch: (body: BodyState) => Partial<BodyState>) => {
      updateActiveTab((tab) => ({ body: { ...tab.body, ...patch(tab.body) } }))
    },
    [updateActiveTab],
  )

  /** Adjust Content-Type when the body type or language changes, rather than on every keystroke. */
  const setBodyType = useCallback(
    (type: BodyType) => {
      updateActiveTab((tab) => ({
        body: { ...tab.body, type },
        headers: syncContentTypeHeader(tab.headers, contentTypeFor(type, tab.body.rawLanguage), nextHeaderId),
      }))
    },
    [updateActiveTab],
  )

  const setRawLanguage = useCallback(
    (rawLanguage: RawBodyLanguage) => {
      updateActiveTab((tab) => ({
        body: { ...tab.body, rawLanguage },
        headers: syncContentTypeHeader(tab.headers, contentTypeFor(tab.body.type, rawLanguage), nextHeaderId),
      }))
    },
    [updateActiveTab],
  )

  const setRawBody = useCallback((raw: string) => updateBody(() => ({ raw })), [updateBody])
  const setBinaryFilePath = useCallback((binaryFilePath: string) => updateBody(() => ({ binaryFilePath })), [updateBody])

  const addUrlEncodedField = useCallback(
    () => updateBody((body) => ({ urlEncoded: [...body.urlEncoded, emptyUrlEncodedEntry()] })),
    [updateBody],
  )
  const updateUrlEncodedField = useCallback(
    (id: string, patch: Partial<Omit<UrlEncodedEntry, 'id'>>) =>
      updateBody((body) => ({ urlEncoded: body.urlEncoded.map((row) => (row.id === id ? { ...row, ...patch } : row)) })),
    [updateBody],
  )
  const removeUrlEncodedField = useCallback(
    (id: string) => updateBody((body) => ({ urlEncoded: body.urlEncoded.filter((row) => row.id !== id) })),
    [updateBody],
  )
  const replaceUrlEncodedFields = useCallback(
    (rows: BulkRow[]) =>
      updateBody((body) => {
        const matches = matchExistingRows(body.urlEncoded, rows)
        return { urlEncoded: rows.map((row, index) => ({ id: matches[index]?.id ?? emptyUrlEncodedEntry().id, ...row })) }
      }),
    [updateBody],
  )

  const addFormDataField = useCallback(
    () => updateBody((body) => ({ formData: [...body.formData, emptyFormDataEntry()] })),
    [updateBody],
  )
  const updateFormDataField = useCallback(
    (id: string, patch: Partial<Omit<FormDataEntry, 'id'>>) =>
      updateBody((body) => ({ formData: body.formData.map((row) => (row.id === id ? { ...row, ...patch } : row)) })),
    [updateBody],
  )
  const removeFormDataField = useCallback(
    (id: string) => updateBody((body) => ({ formData: body.formData.filter((row) => row.id !== id) })),
    [updateBody],
  )
  const setPreRequestScript = useCallback((value: string) => updateActiveTab({ preRequestScript: value }), [updateActiveTab])
  const setPostResponseScript = useCallback((value: string) => updateActiveTab({ postResponseScript: value }), [updateActiveTab])

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    /** Active environment overlaid by the active request collection/folder variables. */
    effectiveVariables,
    openRequest,
    openHistoryEntry,
    restoreTabs,
    newDraftTab,
    openDraft,
    openFlowNodeRequest,
    editFlowRequestDraft,
    renameFlowNode,
    selectTab,
    pinTab,
    pinRequest,
    closePreviewTab,
    reorderTabs,
    reorderTabsGroup,
    closeTab,
    closeAllTabs,
    closeOtherTabs,
    closeTabsWhere,
    toggleFixTab,
    markSaved,
    markContentSaved,
    renameTab,
    detachRequest,
    contentOfTab,
    replaceTabContent,
    endpointUrl: activeTab.endpointUrl,
    setEndpointUrl,
    activeSection: activeTab.activeSection,
    setActiveSection,
    protocol: activeTab.protocol,
    method: activeTab.method,
    setMethod,
    query: activeTab.query,
    setQuery,
    variables: activeTab.variables,
    setVariables,
    body: activeTab.body,
    setBodyType,
    setRawLanguage,
    setRawBody,
    setBinaryFilePath,
    addUrlEncodedField,
    updateUrlEncodedField,
    removeUrlEncodedField,
    replaceUrlEncodedFields,
    addFormDataField,
    updateFormDataField,
    removeFormDataField,
    preRequestScript: activeTab.preRequestScript,
    postResponseScript: activeTab.postResponseScript,
    setPreRequestScript,
    setPostResponseScript,
    headers: activeTab.headers,
    addHeader,
    updateHeader,
    removeHeader,
    replaceHeaders,
    params: activeTab.params,
    addParam,
    updateParam,
    removeParam,
    replaceParams,
    routeParams: activeTab.routeParams,
    updateRouteParam,
    updateRouteParamName,
    removeRouteParam,
    authorization: activeTab.authorization,
    updateAuthorization,
    execution: activeTab.execution,
    send,
    sendGrpc,
    grpcStream: activeTab.grpcStream,
    controlGrpcStream,
    cancel,
    clearResponse,
    schema: activeTab.schema,
    loadSchema,
    cancelSchemaLoad,
    grpc: activeTab.grpc,
    updateGrpc,
    grpcSchema: activeTab.grpcSchema,
    loadGrpcSchema,
    toggleQueryField,
    setQueryFieldArgument,
  }
}
