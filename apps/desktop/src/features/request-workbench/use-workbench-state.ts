import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cancelGraphqlRequest } from '../../bindings/cancel-graphql-request'
import { executeGraphqlRequest } from '../../bindings/execute-graphql-request'
import { executeRestRequest } from '../../bindings/execute-rest-request'
import type { HttpMethodInput, RawBodyLanguage } from '../../bindings/execute-rest-request'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
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
import { emptyRequestContent, mergeScopedVariables, variableScopesFor } from './collection-tree'
import {
  emptyAuthorizationState,
  sameAuthentication,
  toAuthenticationInput,
  toAuthorizationState,
} from './authorization-state'
import type { RequestContent, RequestProtocol, TreeNode } from './collection-tree'
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

/** Libera o corpo de resposta cacheado no backend (spec 0020) quando um
 * resultado `windowed` deixa de ser referenciado por nenhuma aba —
 * fire-and-forget, best-effort: o cap do cache já garante o limite de
 * memória mesmo se esta chamada falhar ou nunca acontecer. */
function releaseIfWindowed(execution: ExecutionState) {
  if (execution.status === 'success' && execution.result.body.kind === 'windowed') {
    void releaseResponseBody(execution.result.body.handle)
  }
}

let headerIdSequence = 0
const nextHeaderId = () => `header-${++headerIdSequence}`

let paramIdSequence = 0
const nextParamId = () => `param-${++paramIdSequence}`

let routeParamIdSequence = 0
const nextRouteParamId = () => `route-param-${++routeParamIdSequence}`

/** Deriva a grid de "Params" a partir da query string de `url` — sempre um
 * recálculo completo (nunca mescla com uma lista anterior), usado quando a
 * URL muda por edição direta (digitação, abertura de aba/rascunho). */
function paramsFromUrl(url: string): ParamEntry[] {
  return parseQueryParams(url).map(({ name, value }) => ({ id: nextParamId(), name, value, enabled: true }))
}

/** Deriva os parâmetros de rota da URL, preservando valores já preenchidos
 * quando o mesmo nome continua presente após uma edição do endpoint. */
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
    ...overrides,
  }
}

function tabFromContent(requestId: string | null, name: string, content: RequestContent): WorkbenchTab {
  return createTab({
    requestId,
    name,
    protocol: content.protocol,
    // 'query' (default de createTab) não existe em REST_TABS — abas REST reabertas
    // (requisição salva, restauração de aba/histórico) precisam do default de newDraftTab.
    activeSection: content.protocol === 'rest' ? 'params' : 'query',
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
    savedContent: content,
    dirty: requestId === null,
  })
}

/** Conteúdo salvável da aba — o que "Salvar" grava e o que a sessão de abas guarda como rascunho. */
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

/** Compara o conteúdo editável com o snapshot que originou a aba. Além de
 * calcular `dirty`, fixa abas de pré-visualização assim que o usuário altera
 * a requisição. */
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
    !sameAuthentication(toAuthenticationInput(tab.authorization), saved.authentication)
  )
}

function computeDirty(tab: WorkbenchTab): boolean {
  return (tab.requestId === null && !tab.flowNodeRef) || contentDiffersFromSaved(tab)
}

/** `true` quando a aba tem alterações desde o último carregamento/salvamento — mostra o indicador na `OpenTabsBar`. */
export function isTabDirty(tab: WorkbenchTab): boolean {
  return tab.dirty
}

type TabPatch = Partial<WorkbenchTab> | ((tab: WorkbenchTab) => Partial<WorkbenchTab>)

/** Nunca inserida em `state.tabs` — só evita checagens de nulidade em toda
 * parte quando não há nenhuma aba aberta (tela de descanso). Nesse estado a
 * interface não renderiza nada que leia estes campos. */
const EMPTY_TAB: WorkbenchTab = createTab()

/**
 * `environmentVariables` é só o ambiente ativo; `collections` fornece as variáveis de coleção/pasta da aba ativa
 * (ADR 0031), enviadas em camadas para o backend e mescladas em `effectiveVariables` para exibição.
 */
export function useWorkbenchState(environmentVariables: EnvironmentVariableDto[], rootPath: string, collections: TreeNode[]) {
  const [state, setState] = useState<{ tabs: WorkbenchTab[]; activeTabId: string | null }>({
    tabs: [],
    activeTabId: null,
  })
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  /** Ids de aba para as quais o carregamento automático do schema (abaixo)
   * já foi disparado — evita repetir a chamada a cada re-render enquanto o
   * `loadSchema` daquela aba ainda está em andamento ou já terminou. */
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

  /** `ignoreResponseSizeLimit`: "reenviar sem limite" — só este envio ignora o limite de tamanho de resposta. */
  const send = useCallback(async (options?: { ignoreResponseSizeLimit?: boolean }) => {
    const ignoreResponseSizeLimit = options?.ignoreResponseSizeLimit === true
    const tabId = state.activeTabId
    const tab = activeTab
    releaseIfWindowed(tab.execution)
    const id = crypto.randomUUID()
    // Executar demonstra que a aba já está em uso deliberado. Fixá-la antes
    // do await impede que outra requisição aberta na sidebar substitua o
    // request enquanto a execução ainda está em andamento (ou depois dela).
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

  const cancel = useCallback(() => {
    if (activeTab.executionId) {
      void cancelGraphqlRequest(activeTab.executionId)
    }
  }, [activeTab.executionId])

  const clearResponse = useCallback(() => {
    releaseIfWindowed(activeTab.execution)
    updateTab(state.activeTabId, { executionId: null, lastSendId: null, execution: { status: 'idle' } })
  }, [state.activeTabId, activeTab.execution, updateTab])

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
        // Abas no mesmo endpoint passam a compartilhar uma única instância do schema.
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

  /** Para uma requisição GraphQL já salva, o schema (campos disponíveis no
   * `QueryExplorer`) é buscado sozinho assim que a aba é aberta — sem exigir
   * o clique em "Carregar schema" — porque `load_schema` já resolve do
   * cache em disco (`SchemaStore`) quando o endpoint não mudou, então isso
   * não bate na rede de novo. Só dispara uma vez por aba (`autoSchemaLoadedTabsRef`):
   * uma aba recriada ao fechar e reabrir a requisição tem outro id e volta a
   * carregar; girar entre seções ou editar a query na mesma aba, não. Rascunhos
   * novos (`requestId === null`) continuam exigindo a ação explícita — é onde
   * o endpoint ainda pode ser um valor arbitrário que o usuário está digitando. */
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

  /** Abre uma execução do histórico como pré-visualização editável. Outra
   * requisição ou evento substitui essa aba enquanto ela não for fixada. */
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

  /** Recria as abas da sessão gravada (ADR 0039), substituindo as atuais. Cada aba mantém o id
   * (o histórico de envios é por aba) e é comparada a `savedContent` para o indicador de não salvo. */
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

  /** Abre uma aba em branco — sempre um rascunho avulso (`requestId: null`). */
  const newDraftTab = useCallback((protocol: RequestProtocol, name = '') => {
    setState((current) => {
      const content = emptyRequestContent(protocol)
      const tab =
        protocol === 'rest'
          ? createTab({
              name,
              protocol: 'rest',
              method: content.method,
              endpointUrl: content.endpointUrl,
              activeSection: 'params',
              savedContent: content,
              dirty: true,
            })
          : tabFromContent(null, name, content)
      return { tabs: [...current.tabs, tab], activeTabId: tab.id }
    })
  }, [])

  /** Abre (ou só ativa) a aba que edita a requisição de um node avulso de
   * flow — sem `requestId`, mas não é rascunho: começa sem alterações. */
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

  /** Abre um conteúdo pronto como rascunho avulso (`requestId: null`), ainda não salvo. */
  const openDraft = useCallback((name: string, content: RequestContent) => {
    setState((current) => {
      const tab = tabFromContent(null, name, content)
      return { tabs: [...current.tabs, tab], activeTabId: tab.id }
    })
  }, [])

  const selectTab = useCallback((tabId: string) => {
    setState((current) => ({ ...current, activeTabId: tabId }))
  }, [])

  const pinTab = useCallback(
    (tabId: string) => {
      updateTab(tabId, { pinned: true })
    },
    [updateTab],
  )

  /** Fixa ou desafixa a aba. Fixar também a tira do modo de pré-visualização. */
  const toggleFixTab = useCallback(
    (tabId: string) => {
      updateTab(tabId, (tab) => (tab.fixed ? { fixed: false } : { fixed: true, pinned: true }))
    },
    [updateTab],
  )

  /** Fixa a aba da requisição salva (a tira do modo de pré-visualização), se ela estiver aberta. */
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

  /** Move `draggedId` para antes/depois de `targetId` (arrastar e soltar na `OpenTabsBar`). */
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

  /** Move o grupo `ids` (na ordem em que já estão) para antes/depois de `targetId`. */
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
      if (closing) releaseIfWindowed(closing.execution)
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
    stateRef.current.tabs.forEach((tab) => releaseIfWindowed(tab.execution))
    autoSchemaLoadedTabsRef.current.clear()
    setState({ tabs: [], activeTabId: null })
  }, [])

  /** Fecha todas as abas exceto `tabId` (menu de contexto "excluir abas não selecionadas"). */
  const closeOtherTabs = useCallback(
    (tabId: string) => {
      stateRef.current.tabs
        .filter((tab) => tab.id !== tabId)
        .forEach((tab) => {
          releaseIfWindowed(tab.execution)
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

  /** Fecha as abas cujo id `shouldClose` aceita (excluir não fixadas, excluir selecionadas). Se a
   * ativa sai, a vez passa à primeira aba que sobrou. */
  const closeTabsWhere = useCallback(
    (shouldClose: (tabId: string) => boolean) => {
      stateRef.current.tabs
        .filter((tab) => shouldClose(tab.id))
        .forEach((tab) => {
          releaseIfWindowed(tab.execution)
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

  /** Marca a aba `tabId` como salva no conteúdo atual (após atualizar uma requisição já existente). */
  const markContentSaved = useCallback(
    (tabId: string) => {
      updateTab(tabId, (tab) => ({ savedContent: contentOf(tab) }))
    },
    [updateTab],
  )

  const renameTab = useCallback(
    (tabId: string, name: string) => {
      updateTab(tabId, { name })
    },
    [updateTab],
  )

  /** Desvincula a aba da requisição salva (ex.: removida da coleção) —
   * volta a ser um rascunho não salvo, para que `isTabDirty` sinalize o
   * indicador e "Salvar" não escreva num item que não existe mais. */
  const detachRequest = useCallback(
    (tabId: string) => {
      updateTab(tabId, { requestId: null, flowNodeRef: undefined, pinned: true })
    },
    [updateTab],
  )

  /** Conteúdo salvável da aba `tabId` (não precisa ser a aba ativa — usada pelo "Salvar" do menu de contexto da aba). */
  const contentOfTab = useCallback(
    (tabId: string): RequestContent => contentOf(state.tabs.find((tab) => tab.id === tabId) ?? activeTab),
    [state.tabs, activeTab],
  )

  /** Troca o conteúdo da aba `tabId` (ex.: cURL colado na barra de endpoint),
   * mantendo identidade, nome e vínculo com a requisição salva — o `dirty`
   * segue comparando com o que estava salvo. A seção ativa só muda se o
   * protocolo mudar, porque as seções de REST e GraphQL são outras. */
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
        }
      }),
    [updateTab],
  )

  const setEndpointUrl = useCallback(
    (value: string) =>
      updateActiveTab((tab) => ({
        endpointUrl: value,
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

  /** Troca de tipo/linguagem também ajusta o `Content-Type` na grade de
   * headers (ver `syncContentTypeHeader`) — nunca a cada tecla digitada. */
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
    /** Ambiente ativo sobreposto pelas variáveis da coleção/pastas da aba ativa. */
    effectiveVariables,
    openRequest,
    openHistoryEntry,
    restoreTabs,
    newDraftTab,
    openDraft,
    openFlowNodeRequest,
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
    cancel,
    clearResponse,
    schema: activeTab.schema,
    loadSchema,
    cancelSchemaLoad,
    toggleQueryField,
    setQueryFieldArgument,
  }
}
