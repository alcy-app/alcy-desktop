import type {
  AuthenticationInput,
  HeaderInput,
  ScopedVariableChange,
  VariableScopeInput,
} from '../../bindings/execute-graphql-request'
import type { CollectionLabelDto, DocsRefDto, ScopedVariableDto } from '../../bindings/list-collections'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import type { HttpMethodInput, RestBodyInput } from '../../bindings/execute-rest-request'
import type { GrpcSchemaSourceDto } from '../../bindings/grpc-call'
import type { WebSocketCallDto, WebSocketMessageFormat } from '../../bindings/websocket-call'
import type { ItemChangeKind } from '../../bindings/gitlab-types'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import { definedVariables } from '../environments/defined-variables'
import { emptyRestBody } from './body-state'

export type RequestProtocol = 'graphql' | 'rest' | 'grpc' | 'websocket'

/** What a gRPC request calls (spec 0129); the other protocols keep the
 * default and ignore it, like `method`/`body` for GraphQL. */
export interface GrpcCallState {
  /** Fully qualified service (`package.Service`); empty until chosen. */
  service: string
  method: string
  schemaSource: GrpcSchemaSourceDto
  /** `null` uses the configured request timeout. */
  deadlineMs: number | null
  /** The request message, as JSON. */
  message: string
}

export const emptyGrpcCall: GrpcCallState = {
  service: '',
  method: '',
  schemaSource: { type: 'reflection' },
  deadlineMs: null,
  message: '{}',
}

export function sameGrpcCall(a: GrpcCallState, b: GrpcCallState): boolean {
  return (
    a.service === b.service &&
    a.method === b.method &&
    a.deadlineMs === b.deadlineMs &&
    a.message === b.message &&
    JSON.stringify(a.schemaSource) === JSON.stringify(b.schemaSource)
  )
}

/** What a WebSocket request offers and sends (spec 0140); the other
 * protocols ignore it. The message is the saved body. */
export interface WebSocketCallState {
  message: string
  messageFormat: WebSocketMessageFormat
  subprotocols: string[]
  /** Runs and flows only; `null` uses the request timeout. */
  waitMs: number | null
  /** Runs and flows only; `null` means 1, 0 waits for `waitMs`. */
  expectedMessages: number | null
}

export const emptyWebSocketCall: WebSocketCallState = {
  message: '',
  messageFormat: 'text',
  subprotocols: [],
  waitMs: null,
  expectedMessages: null,
}

export function sameWebSocketCall(a: WebSocketCallState, b: WebSocketCallState): boolean {
  return (
    a.message === b.message &&
    a.messageFormat === b.messageFormat &&
    a.waitMs === b.waitMs &&
    a.expectedMessages === b.expectedMessages &&
    a.subprotocols.length === b.subprotocols.length &&
    a.subprotocols.every((subprotocol, index) => subprotocol === b.subprotocols[index])
  )
}

/** A content's WebSocket call; contents of the other protocols (and older
 * snapshots) may omit it. */
export function websocketOf(content: Pick<RequestContent, 'websocket'>): WebSocketCallState {
  return content.websocket ?? emptyWebSocketCall
}

/** The saved call without the message, which is saved as the body. */
export function websocketCallDto(call: WebSocketCallState): WebSocketCallDto {
  return {
    subprotocols: call.subprotocols,
    messageFormat: call.messageFormat,
    waitMs: call.waitMs,
    expectedMessages: call.expectedMessages,
  }
}

export function websocketFromDto(dto: WebSocketCallDto | null | undefined, message: string): WebSocketCallState {
  return {
    message,
    messageFormat: dto?.messageFormat ?? 'text',
    subprotocols: dto?.subprotocols ?? [],
    waitMs: dto?.waitMs ?? null,
    expectedMessages: dto?.expectedMessages ?? null,
  }
}

export interface RouteParameter {
  name: string
  value: string
}

/** O conteúdo de uma requisição salva — o suficiente para recarregar o
 * editor de volta ao estado em que ela foi salva. `method`/`body` são
 * paralelos a `query`/`variables` (mesma escolha de modelagem que
 * `WorkbenchTab`, spec 0028): só um dos pares faz sentido de acordo com
 * `protocol`, o outro fica com os valores padrão. */
export interface RequestContent {
  protocol: RequestProtocol
  endpointUrl: string
  query: string
  variables: string
  method: HttpMethodInput
  body: RestBodyInput
  headers: HeaderInput[]
  authentication: AuthenticationInput
  preRequestScript: string
  postResponseScript: string
  routeParams: RouteParameter[]
  grpc: GrpcCallState
  /** WebSocket call (spec 0140); absent for the other protocols. */
  websocket?: WebSocketCallState
}

export interface RequestSummary {
  id: string
  name: string
  protocol: RequestProtocol
  content: RequestContent
  /** Documentação importada (ADR 0035). Fica fora de `content` porque salvar
   * a aba substitui o conteúdo inteiro, e a referência não é editável. */
  docsRef?: DocsRefDto | null
}

/** A request's method as labels show it: the HTTP method, or the protocol
 * name for protocols without one. */
export function requestMethodLabel(request: Pick<RequestSummary, 'protocol' | 'content'>): string {
  switch (request.protocol) {
    case 'graphql':
      return 'GraphQL'
    case 'grpc':
      return 'gRPC'
    case 'websocket':
      return 'WS'
    case 'rest':
      return request.content.method.toUpperCase()
  }
}

/** Conteúdo de uma requisição recém-criada, ainda sem edição — os defaults
 * dependem do protocolo. Nasce sem URL (spec 0089): nenhum endereço base é
 * presumido, nem nas coleções nem nos flows. */
export function emptyRequestContent(protocol: RequestProtocol): RequestContent {
  if (protocol === 'websocket') {
    return {
      protocol: 'websocket',
      endpointUrl: '',
      query: '',
      variables: '',
      method: 'get',
      body: emptyRestBody,
      headers: [],
      authentication: { type: 'inherit' },
      preRequestScript: '',
      postResponseScript: '',
      routeParams: [],
      grpc: emptyGrpcCall,
      websocket: emptyWebSocketCall,
    }
  }
  if (protocol === 'grpc') {
    return {
      protocol: 'grpc',
      endpointUrl: '',
      query: '',
      variables: '',
      method: 'post',
      body: emptyRestBody,
      headers: [],
      authentication: { type: 'inherit' },
      preRequestScript: '',
      postResponseScript: '',
      routeParams: [],
      grpc: emptyGrpcCall,
    }
  }
  if (protocol === 'rest') {
    return {
      protocol: 'rest',
      endpointUrl: '',
      query: '',
      variables: '',
      method: 'get',
      body: emptyRestBody,
      headers: [],
      authentication: { type: 'inherit' },
      preRequestScript: '',
      postResponseScript: '',
      routeParams: [],
      grpc: emptyGrpcCall,
    }
  }

  return {
    protocol: 'graphql',
    endpointUrl: '',
    query: '',
    variables: '{}',
    method: 'post',
    body: emptyRestBody,
    headers: [],
    authentication: { type: 'inherit' },
    preRequestScript: '',
    postResponseScript: '',
    routeParams: [],
    grpc: emptyGrpcCall,
  }
}

/**
 * Uma coleção e uma pasta têm a mesma forma (`id`, `name`, subpastas,
 * requisições) — ver a decisão de modelagem equivalente em
 * `alcy-domain`. As coleções de um workspace são só o nível raiz de uma
 * floresta de `TreeNode`.
 */
export interface TreeNode {
  id: string
  name: string
  folders: TreeNode[]
  requests: RequestSummary[]
  /** Autenticação herdada pelas requisições descendentes que usam `inherit`. */
  authentication: AuthenticationInput
  /** Variáveis de escopo local, herdadas pelas requisições descendentes (ADR 0031). */
  variables: ScopedVariableDto[]
  /** Rótulos da collection (ADR 0060). Só existe no nível raiz; pastas não têm rótulos. */
  labels?: CollectionLabelDto[]
}

export type ChildKind = 'folder' | 'request'

/** Direção da ordenação alfabética aplicada ao conteúdo direto de uma collection ou pasta. */
export type AlphabeticalSortDirection = 'ascending' | 'descending'

function mapFolderNode(nodes: TreeNode[], id: string, fn: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) =>
    node.id === id ? fn(node) : { ...node, folders: mapFolderNode(node.folders, id, fn) },
  )
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.folders, id)
    if (found) return found
  }
  return null
}

export function findRequest(nodes: TreeNode[], id: string): RequestSummary | null {
  for (const node of nodes) {
    const found = node.requests.find((request) => request.id === id)
    if (found) return found
    const inChild = findRequest(node.folders, id)
    if (inChild) return inChild
  }
  return null
}

/** Retorna o caminho nominal completo até uma requisição, começando pela
 * coleção raiz e incluindo pastas intermediárias e a própria requisição. */
export function findRequestPath(nodes: TreeNode[], id: string): string[] | null {
  for (const node of nodes) {
    const request = node.requests.find((candidate) => candidate.id === id)
    if (request) return [node.name, request.name]

    const nestedPath = findRequestPath(node.folders, id)
    if (nestedPath) return [node.name, ...nestedPath]
  }
  return null
}

/** Ids da coleção e das pastas que contêm a requisição (da raiz até o pai direto) — o que precisa estar
 * expandido para a requisição ficar visível. `null` se ela não estiver na árvore. */
export function findAncestorIds(nodes: TreeNode[], requestId: string): string[] | null {
  for (const node of nodes) {
    if (node.requests.some((candidate) => candidate.id === requestId)) return [node.id]

    const nested = findAncestorIds(node.folders, requestId)
    if (nested) return [node.id, ...nested]
  }
  return null
}

/** `null` = a lista raiz (nível das coleções); `undefined` = `id` não existe na árvore. */
export function findParentId(nodes: TreeNode[], id: string, parentId: string | null = null): string | null | undefined {
  for (const node of nodes) {
    if (node.id === id) return parentId
    if (node.requests.some((request) => request.id === id)) return node.id
    const found = findParentId(node.folders, id, node.id)
    if (found !== undefined) return found
  }
  return undefined
}

function siblingItems(nodes: TreeNode[], parentId: string | null, kind: ChildKind): { id: string; name: string }[] {
  if (parentId === null) return kind === 'folder' ? nodes : []
  const parent = findNode(nodes, parentId)
  if (!parent) return []
  return kind === 'folder' ? parent.folders : parent.requests
}

function uniqueAmong(base: string, takenNames: string[]): string {
  if (!takenNames.includes(base)) return base
  let attempt = 2
  while (takenNames.includes(`${base} ${attempt}`)) attempt++
  return `${base} ${attempt}`
}

/** `parentId === null` insere no nível raiz (uma nova coleção). */
export function insertFolder(nodes: TreeNode[], parentId: string | null, folder: TreeNode): TreeNode[] {
  if (parentId === null) return [...nodes, folder]
  return mapFolderNode(nodes, parentId, (node) => ({ ...node, folders: [...node.folders, folder] }))
}

export function insertRequest(nodes: TreeNode[], parentId: string, request: RequestSummary): TreeNode[] {
  return mapFolderNode(nodes, parentId, (node) => ({ ...node, requests: [...node.requests, request] }))
}

/**
 * Ordena somente o conteúdo direto da collection/pasta indicada. Pastas e
 * requisições continuam em grupos separados, como na árvore visual, e cada
 * grupo é ordenado de modo natural e sem diferenciar maiúsculas de minúsculas.
 */
export function sortNodeChildren(nodes: TreeNode[], id: string, direction: AlphabeticalSortDirection): TreeNode[] {
  const node = findNode(nodes, id)
  if (!node) return nodes

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const compareByName = <T extends { name: string }>(left: T, right: T) => {
    const result = collator.compare(left.name, right.name)
    return direction === 'ascending' ? result : -result
  }
  const folders = [...node.folders].sort(compareByName)
  const requests = [...node.requests].sort(compareByName)
  const foldersChanged = folders.some((folder, index) => folder !== node.folders[index])
  const requestsChanged = requests.some((request, index) => request !== node.requests[index])

  if (!foldersChanged && !requestsChanged) return nodes
  return mapFolderNode(nodes, id, (current) => ({ ...current, folders, requests }))
}

export function renameNode(nodes: TreeNode[], id: string, name: string): TreeNode[] {
  return nodes.map((node) => {
    if (node.id === id) return { ...node, name }
    return {
      ...node,
      folders: renameNode(node.folders, id, name),
      requests: node.requests.map((request) => (request.id === id ? { ...request, name } : request)),
    }
  })
}

export function removeNode(nodes: TreeNode[], id: string): TreeNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({
      ...node,
      folders: removeNode(node.folders, id),
      requests: node.requests.filter((request) => request.id !== id),
    }))
}

/** Remove vários itens de uma vez (seleção múltipla, spec 0104). */
export function removeNodes(nodes: TreeNode[], ids: Iterable<string>): TreeNode[] {
  let next = nodes
  for (const id of ids) next = removeNode(next, id)
  return next
}

/**
 * Ids de `selected` que de fato estão na árvore, na ordem da árvore (como as
 * linhas aparecem: pastas antes de requisições), sem os itens cujo ancestral
 * também está selecionado — o pai já leva o filho em qualquer operação em lote.
 */
export function topLevelSelection(nodes: TreeNode[], selected: ReadonlySet<string>): string[] {
  const ids: string[] = []
  const visit = (list: TreeNode[]) => {
    for (const node of list) {
      if (selected.has(node.id)) {
        ids.push(node.id)
        continue
      }
      visit(node.folders)
      for (const request of node.requests) {
        if (selected.has(request.id)) ids.push(request.id)
      }
    }
  }
  visit(nodes)
  return ids
}

/** Ids de todas as subpastas e requisições dentro de `id`, sem o próprio; vazio para uma requisição. */
export function descendantIds(nodes: TreeNode[], id: string): string[] {
  const node = findNode(nodes, id)
  if (!node) return []
  const ids: string[] = []
  const visit = (current: TreeNode) => {
    for (const folder of current.folders) {
      ids.push(folder.id)
      visit(folder)
    }
    for (const request of current.requests) ids.push(request.id)
  }
  visit(node)
  return ids
}

/** `ids` mais tudo o que está dentro das coleções/pastas entre eles — marcar uma pasta marca o conteúdo. */
export function withDescendants(nodes: TreeNode[], ids: Iterable<string>): string[] {
  return [...ids].flatMap((id) => [id, ...descendantIds(nodes, id)])
}

/**
 * Alterna `id` na seleção levando o conteúdo junto: marcar uma coleção/pasta
 * marca tudo dentro dela; desmarcar um item desmarca o conteúdo dele e também
 * os ancestrais — senão o pai, ainda marcado, continuaria levando o item.
 */
export function toggleTreeSelection(nodes: TreeNode[], selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  const subtree = withDescendants(nodes, [id])
  if (!selected.has(id)) {
    for (const item of subtree) next.add(item)
    return next
  }
  for (const item of subtree) next.delete(item)
  for (let parentId = findParentId(nodes, id); typeof parentId === 'string'; parentId = findParentId(nodes, parentId)) {
    next.delete(parentId)
  }
  return next
}

/** Ids das linhas renderizadas, em ordem — só desce nas pastas expandidas (intervalo do Shift+clique). */
export function visibleItemIds(nodes: TreeNode[], expandedIds: ReadonlySet<string>): string[] {
  const ids: string[] = []
  const visit = (list: TreeNode[]) => {
    for (const node of list) {
      ids.push(node.id)
      if (!expandedIds.has(node.id)) continue
      visit(node.folders)
      for (const request of node.requests) ids.push(request.id)
    }
  }
  visit(nodes)
  return ids
}

/** Pastas/coleções de `ids` e todas as subpastas delas — destinos que um lote contendo essas pastas não pode ter. */
export function folderSubtreeIds(nodes: TreeNode[], ids: Iterable<string>): Set<string> {
  const result = new Set<string>()
  for (const id of ids) {
    const node = findNode(nodes, id)
    if (!node) continue
    for (const folderId of collectFolderIds(node)) result.add(folderId)
  }
  return result
}

/**
 * Move pastas e requisições de `ids` para dentro de `targetParentId`, na
 * ordem da árvore, deduplicando nomes de pastas como `moveFolder`.
 * Coleções (nível raiz) e o próprio destino são ignorados; uma pasta não
 * vai para dentro de si mesma (proteção de `moveFolder`).
 */
export function moveItems(nodes: TreeNode[], ids: Iterable<string>, targetParentId: string): TreeNode[] {
  let next = nodes
  for (const id of topLevelSelection(nodes, new Set(ids))) {
    if (id === targetParentId || nodes.some((collection) => collection.id === id)) continue
    next = findNode(next, id) ? moveFolder(next, id, targetParentId) : moveRequest(next, id, targetParentId)
  }
  return next
}

/** Nome livre entre os irmãos de `parentId` (`null` = nível das coleções) para um novo item. */
export function uniqueChildName(nodes: TreeNode[], parentId: string | null, kind: ChildKind, base: string): string {
  return uniqueAmong(
    base,
    siblingItems(nodes, parentId, kind).map((item) => item.name),
  )
}

/** Nome livre entre os irmãos de `id` (excluindo o próprio `id`) para renomear um item existente. */
export function uniqueSiblingName(nodes: TreeNode[], id: string, kind: ChildKind, base: string): string {
  const parentId = findParentId(nodes, id)
  if (parentId === undefined) return base

  const takenNames = siblingItems(nodes, parentId, kind)
    .filter((item) => item.id !== id)
    .map((item) => item.name)

  return uniqueAmong(base, takenNames)
}

/** `true` quando `id` é uma pasta/coleção (tem `.folders`); `false` quando é uma requisição. */
export function kindOf(nodes: TreeNode[], id: string): ChildKind {
  return findNode(nodes, id) ? 'folder' : 'request'
}

/** Insere uma cópia de `id` como próxima irmã do original, com `newId` e `name`. */
export function duplicateRequest(nodes: TreeNode[], id: string, newId: string, name: string): TreeNode[] {
  return nodes.map((node) => ({
    ...node,
    folders: duplicateRequest(node.folders, id, newId, name),
    requests: node.requests.flatMap((request) =>
      request.id === id ? [request, { ...request, id: newId, name }] : [request],
    ),
  }))
}

/** Move a requisição `id` para `targetParentId`, mantendo o nome (requisições irmãs podem ter o mesmo nome). */
export function moveRequest(nodes: TreeNode[], id: string, targetParentId: string): TreeNode[] {
  const original = findRequest(nodes, id)
  if (!original) return nodes

  return insertRequest(removeNode(nodes, id), targetParentId, original)
}

function insertRequestAt(
  nodes: TreeNode[],
  parentId: string,
  targetId: string,
  edge: SiblingEdge,
  request: RequestSummary,
): TreeNode[] {
  return mapFolderNode(nodes, parentId, (node) => {
    const index = node.requests.findIndex((sibling) => sibling.id === targetId)
    if (index === -1) return { ...node, requests: [...node.requests, request] }
    const insertIndex = edge === 'after' ? index + 1 : index
    return { ...node, requests: [...node.requests.slice(0, insertIndex), request, ...node.requests.slice(insertIndex)] }
  })
}

/**
 * Reposiciona a requisição `id` para antes/depois de `targetId` (outra
 * requisição), no pai de `targetId` — cobre tanto reordenar dentro da
 * mesma pasta quanto mover para outra pasta já numa posição específica
 * (em vez de sempre cair no fim, como `moveRequest`).
 */
export function reorderRequest(nodes: TreeNode[], id: string, targetId: string, edge: SiblingEdge): TreeNode[] {
  if (id === targetId) return nodes
  const original = findRequest(nodes, id)
  if (!original) return nodes

  const withoutRequest = removeNode(nodes, id)
  const targetParentId = findParentId(withoutRequest, targetId)
  if (!targetParentId) return nodes

  return insertRequestAt(withoutRequest, targetParentId, targetId, edge, original)
}

function collectFolderIds(node: TreeNode): Set<string> {
  const ids = new Set<string>([node.id])
  for (const child of node.folders) {
    for (const id of collectFolderIds(child)) ids.add(id)
  }
  return ids
}

/** Ids de todas as collections e pastas de uma floresta, recursivamente. */
export function allFolderIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    for (const id of collectFolderIds(node)) ids.add(id)
  }
  return ids
}

/**
 * Move a pasta/coleção `id` para dentro de `targetParentId`, deduplicando
 * o nome entre os irmãos do destino. Rejeita (retorna `nodes` sem
 * alteração) mover para dentro de si mesma ou de uma de suas próprias
 * subpastas — isso quebraria a árvore.
 */
export function moveFolder(nodes: TreeNode[], id: string, targetParentId: string): TreeNode[] {
  const original = findNode(nodes, id)
  if (!original) return nodes
  if (collectFolderIds(original).has(targetParentId)) return nodes

  const withoutFolder = removeNode(nodes, id)
  const name = uniqueChildName(withoutFolder, targetParentId, 'folder', original.name)
  return insertFolder(withoutFolder, targetParentId, { ...original, name })
}

function insertFolderAt(nodes: TreeNode[], parentId: string, targetId: string, edge: SiblingEdge, folder: TreeNode): TreeNode[] {
  return mapFolderNode(nodes, parentId, (node) => {
    const index = node.folders.findIndex((sibling) => sibling.id === targetId)
    if (index === -1) return { ...node, folders: [...node.folders, folder] }
    const insertIndex = edge === 'after' ? index + 1 : index
    return { ...node, folders: [...node.folders.slice(0, insertIndex), folder, ...node.folders.slice(insertIndex)] }
  })
}

/**
 * Reposiciona a pasta `id` para antes/depois de `targetId` (outra pasta),
 * como irmã dela no mesmo pai — cobre tanto reordenar dentro da mesma
 * pasta/coleção quanto mover para outro pai já numa posição específica.
 * Se `targetId` for uma subpasta de `id`, `findParentId` não a encontra
 * mais depois de `removeNode` (ela some junto com a árvore removida), então
 * a função não altera nada — mesma proteção contra ciclos de `moveFolder`.
 */
export function reorderFolder(nodes: TreeNode[], id: string, targetId: string, edge: SiblingEdge): TreeNode[] {
  if (id === targetId) return nodes
  const original = findNode(nodes, id)
  if (!original) return nodes

  const withoutFolder = removeNode(nodes, id)
  const targetParentId = findParentId(withoutFolder, targetId)
  if (!targetParentId) return nodes

  const name = uniqueChildName(withoutFolder, targetParentId, 'folder', original.name)
  return insertFolderAt(withoutFolder, targetParentId, targetId, edge, { ...original, name })
}

/** Reordena as coleções no nível raiz, posicionando `id` antes/depois de `targetId`. */
export function reorderCollections(nodes: TreeNode[], id: string, targetId: string, edge: SiblingEdge): TreeNode[] {
  if (id === targetId) return nodes
  const index = nodes.findIndex((node) => node.id === id)
  const targetIndex = nodes.findIndex((node) => node.id === targetId)
  if (index === -1 || targetIndex === -1) return nodes

  const withoutDragged = [...nodes.slice(0, index), ...nodes.slice(index + 1)]
  const newTargetIndex = withoutDragged.findIndex((node) => node.id === targetId)
  const insertIndex = edge === 'after' ? newTargetIndex + 1 : newTargetIndex
  return [...withoutDragged.slice(0, insertIndex), nodes[index], ...withoutDragged.slice(insertIndex)]
}

export function updateRequestContent(nodes: TreeNode[], id: string, content: RequestContent): TreeNode[] {
  return nodes.map((node) => ({
    ...node,
    folders: updateRequestContent(node.folders, id, content),
    requests: node.requests.map((request) => (request.id === id ? { ...request, content } : request)),
  }))
}

/**
 * Reatribui `id` (via `newId`) a `node` e a todas as suas pastas e
 * requisições descendentes, recursivamente — usado ao importar um
 * arquivo exportado para não colidir com IDs já existentes na árvore em
 * memória (chave React, alvo de arraste, identidade de busca). Nome e
 * conteúdo de cada item são preservados.
 */
export function regenerateIds(node: TreeNode, newId: () => string = () => crypto.randomUUID()): TreeNode {
  return {
    ...node,
    id: newId(),
    folders: node.folders.map((folder) => regenerateIds(folder, newId)),
    requests: node.requests.map((request) => ({ ...request, id: newId() })),
  }
}

function requestMatches(request: RequestSummary, query: string): boolean {
  return request.name.toLowerCase().includes(query) || request.content.endpointUrl.toLowerCase().includes(query)
}

/** Se o próprio nome de `node` casar com a busca, mantém a subárvore inteira (sem filtrar) — do
 * contrário, filtra pastas e requisições recursivamente e só mantém `node` se algo sobrar. */
function filterNode(node: TreeNode, query: string): TreeNode | null {
  if (node.name.toLowerCase().includes(query)) return node

  const folders = node.folders
    .map((folder) => filterNode(folder, query))
    .filter((folder): folder is TreeNode => folder !== null)
  const requests = node.requests.filter((request) => requestMatches(request, query))
  if (folders.length === 0 && requests.length === 0) return null

  return { ...node, folders, requests }
}

/** Filtra a árvore por um padrão de busca (nome de coleção/pasta/requisição, ou URL da requisição),
 * sem diferenciar maiúsculas/minúsculas. `query` vazia (ou só espaços) devolve `nodes` sem alteração. */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return nodes

  return nodes
    .map((node) => filterNode(node, normalized))
    .filter((node): node is TreeNode => node !== null)
}

/** Troca a autenticação de uma coleção/pasta. */
export function updateNodeAuthentication(nodes: TreeNode[], id: string, authentication: AuthenticationInput): TreeNode[] {
  return mapFolderNode(nodes, id, (node) => ({ ...node, authentication }))
}

/** Troca as variáveis de uma coleção/pasta. */
export function updateNodeVariables(nodes: TreeNode[], id: string, variables: ScopedVariableDto[]): TreeNode[] {
  return mapFolderNode(nodes, id, (node) => ({ ...node, variables }))
}

/** Aplica gravações de script (`al.collection.set`/`al.folder.set`) às coleções/pastas, criando a variável se
 * preciso. Ids que não existem mais são ignorados. */
export function applyScopedChanges(nodes: TreeNode[], changes: ScopedVariableChange[]): TreeNode[] {
  let next = nodes
  for (const change of changes) {
    next = mapFolderNode(next, change.nodeId, (node) => ({ ...node, variables: upsertVariable(node.variables, change) }))
  }
  return next
}

function upsertVariable(variables: ScopedVariableDto[], { name, value }: ScopedVariableChange): ScopedVariableDto[] {
  if (value === null) return variables.filter((variable) => variable.name !== name)
  return variables.some((variable) => variable.name === name)
    ? variables.map((variable) => (variable.name === name ? { name, value } : variable))
    : [...variables, { name, value }]
}

/** Camadas de variáveis de uma requisição salva, da coleção até a pasta pai direta — espelha `variable_scopes`
 * do backend (`alcy-domain`). Aba ainda não salva não tem camadas. */
export function variableScopesFor(nodes: TreeNode[], requestId: string | null): VariableScopeInput[] {
  if (requestId === null) return []
  return (pathToRequest(nodes, requestId) ?? []).map((node, index) => ({
    nodeId: node.id,
    kind: index === 0 ? 'collection' : 'folder',
    variables: definedVariables(node.variables),
  }))
}

/** Coleção/pasta que define uma variável vigente. */
export interface VariableSource {
  nodeId: string
  kind: 'collection' | 'folder'
  name: string
}

/** Variável vigente numa requisição: do ambiente ativo (sem `source`) ou de uma coleção/pasta. */
export interface EffectiveVariable extends EnvironmentVariableDto {
  source?: VariableSource
}

/** Ambiente ativo sobreposto pelas variáveis da coleção e das pastas da requisição — o mais próximo vence, como
 * `merge_variables` do backend. Só para exibição (destaque, sugestões, cartão); quem resolve na execução é o backend. */
export function mergeScopedVariables(
  environment: EnvironmentVariableDto[],
  nodes: TreeNode[],
  requestId: string | null,
): EffectiveVariable[] {
  return mergeChain(environment, requestId === null ? [] : (pathToRequest(nodes, requestId) ?? []))
}

/** Como `mergeScopedVariables`, para os campos de uma coleção/pasta: o ambiente sobreposto pelas variáveis dos
 * ancestores de `nodeId` (sem as dele próprio, que estão em edição). */
export function variablesAboveNode(environment: EnvironmentVariableDto[], nodes: TreeNode[], nodeId: string): EffectiveVariable[] {
  return mergeChain(environment, (pathToNode(nodes, nodeId) ?? []).slice(0, -1))
}

/** `chain` vai da coleção raiz para baixo. */
function mergeChain(environment: EnvironmentVariableDto[], chain: TreeNode[]): EffectiveVariable[] {
  if (chain.every((node) => node.variables.length === 0)) return environment

  const merged = new Map<string, EffectiveVariable>(environment.map((variable) => [variable.name, variable]))
  chain.forEach((node, index) => {
    const source: VariableSource = { nodeId: node.id, kind: index === 0 ? 'collection' : 'folder', name: node.name }
    for (const { name, value } of node.variables) merged.set(name, { name, value, sensitive: false, source })
  })
  return [...merged.values()]
}

export interface InheritedAuthenticationSource {
  /** Nome da coleção/pasta que define a autenticação efetiva; `null` quando nenhuma define (resulta em "sem autenticação"). */
  name: string | null
  authentication: AuthenticationInput
}

/** Autenticação efetiva herdada por uma requisição salva: a da coleção/pasta ancestral mais próxima cujo
 * tipo não seja `inherit` — espelha `effective_authentication` do backend (`alcy-domain`). */
export function findInheritedAuthentication(nodes: TreeNode[], requestId: string): InheritedAuthenticationSource {
  const chain = pathToRequest(nodes, requestId) ?? []
  for (const node of chain.reverse()) {
    if (node.authentication.type !== 'inherit') return { name: node.name, authentication: node.authentication }
  }
  return { name: null, authentication: { type: 'none' } }
}

/** Caminho da coleção raiz até a coleção/pasta `id` (inclusive), ou `null` se ela não existir. */
function pathToNode(nodes: TreeNode[], id: string): TreeNode[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node]
    const nested = pathToNode(node.folders, id)
    if (nested) return [node, ...nested]
  }
  return null
}

/** Ancestrais (da coleção raiz até o pai direto) da requisição, ou `null` se ela não existir. */
function pathToRequest(nodes: TreeNode[], requestId: string): TreeNode[] | null {
  for (const node of nodes) {
    if (node.requests.some((request) => request.id === requestId)) return [node]
    const nested = pathToRequest(node.folders, requestId)
    if (nested) return [node, ...nested]
  }
  return null
}

/** Entre `deleted`/`modified`/`added`, a que "vence" ao resumir várias alterações num só indicador — mesma
 * ideia de prioridade de `version-summary.ts` (conflito > local > remoto), aplicada aqui a um conjunto de itens. */
function strongerChangeKind(a: ItemChangeKind, b: ItemChangeKind): ItemChangeKind {
  const rank: Record<ItemChangeKind, number> = { deleted: 3, modified: 2, added: 1 }
  return rank[b] > rank[a] ? b : a
}

/**
 * Para cada pasta/coleção, o tipo de alteração mais forte entre seus
 * descendentes que têm marca própria em `changeMarkers` — não conta a marca
 * da própria pasta (só o que está por dentro dela). Usado para propagar um
 * indicador (bolinha) até pastas/coleções que não mudaram elas mesmas, mas
 * contêm algo que mudou.
 */
export function nestedChangeKinds(nodes: TreeNode[], changeMarkers: Map<string, ItemChangeKind>): Map<string, ItemChangeKind> {
  const nested = new Map<string, ItemChangeKind>()

  // Devolve a marca "efetiva" do nó (a própria, se houver, senão a agregada dos
  // descendentes) para o pai poder incluí-la na própria agregação.
  const visit = (node: TreeNode): ItemChangeKind | undefined => {
    let aggregated: ItemChangeKind | undefined
    const consider = (kind: ItemChangeKind | undefined) => {
      if (!kind) return
      aggregated = aggregated ? strongerChangeKind(aggregated, kind) : kind
    }

    for (const folder of node.folders) consider(visit(folder))
    for (const request of node.requests) consider(changeMarkers.get(request.id))

    const ownKind = changeMarkers.get(node.id)
    // Só entra no mapa quando a pasta não tem marca própria — é ela quem
    // decide o que mostrar (o chamador não precisa checar as duas).
    if (aggregated && !ownKind) nested.set(node.id, aggregated)
    return ownKind ?? aggregated
  }

  for (const node of nodes) visit(node)
  return nested
}
