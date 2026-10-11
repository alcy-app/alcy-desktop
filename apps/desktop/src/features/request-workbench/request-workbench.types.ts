import type {
  ExecuteGraphqlRequestError,
  ExecuteGraphqlRequestOutput,
  GraphqlErrorOutput,
} from '../../bindings/execute-graphql-request'
import type {
  ExecuteRestRequestError,
  ExecuteRestRequestOutput,
  HttpMethodInput,
  RawBodyLanguage,
} from '../../bindings/execute-rest-request'
import type { LoadSchemaError, LoadSchemaOutput } from '../../bindings/load-schema'
import type { RequestContent } from './collection-tree'

export type { HttpMethodInput, RawBodyLanguage }

/** Protocolo de uma aba aberta no workbench — tipo próprio (em vez de
 * reaproveitar `RequestProtocol` de `collection-tree.ts`) porque descreve
 * conceitos distintos: uma aba aberta vs. o que uma requisição salva numa
 * coleção carrega. Hoje os dois têm os mesmos valores. */
export type WorkbenchProtocol = 'graphql' | 'rest'

export type RequestTabId =
  | 'docs'
  | 'query'
  | 'variables'
  | 'params'
  | 'body'
  | 'scripts'
  | 'headers'
  | 'authorization'
  | 'schema'
export type ResponseTabId = 'body' | 'headers' | 'errors' | 'tests'

export interface WorkbenchEnvironment {
  id: string
  name: string
}

export interface HeaderEntry {
  id: string
  name: string
  value: string
  enabled: boolean
}

/** Uma linha da grid de "Params" — sempre derivada da query string de
 * `WorkbenchTab.endpointUrl` e serializada de volta nela, nunca persistida
 * separadamente (ver `use-workbench-state.ts`). */
export interface ParamEntry {
  id: string
  name: string
  value: string
  enabled: boolean
}

/** Valor de um placeholder `:nome` derivado do caminho da URL. O nome é
 * editável pela grid e sincronizado de volta no token da URL. */
export interface RouteParamEntry {
  id: string
  name: string
  value: string
}

export type BodyType = 'none' | 'formData' | 'urlencoded' | 'raw' | 'binary'

export interface UrlEncodedEntry {
  id: string
  name: string
  value: string
  enabled: boolean
}

export interface FormDataEntry {
  id: string
  name: string
  enabled: boolean
  kind: 'text' | 'file'
  /** Valor quando `kind === 'text'`. */
  value: string
  /** Caminho absoluto quando `kind === 'file'`. */
  filePath: string
}

/** Corpo REST em edição. Guarda os dados de todos os tipos ao mesmo tempo
 * para que alternar entre eles não descarte o que já foi digitado — só o
 * tipo ativo é enviado e salvo (ver `toRestBodyInput`). */
export interface BodyState {
  type: BodyType
  raw: string
  rawLanguage: RawBodyLanguage
  urlEncoded: UrlEncodedEntry[]
  formData: FormDataEntry[]
  binaryFilePath: string
}

export type AuthorizationType = 'inherit' | 'none' | 'customHeader' | 'bearer' | 'basic' | 'digest' | 'oauth2ClientCredentials'

export interface AuthorizationState {
  type: AuthorizationType
  headerName: string
  headerValue: string
  token: string
  username: string
  password: string
  clientId: string
  clientSecret: string
  tokenUrl: string
  scope: string
}

export type ExecutionSuccess = ExecuteGraphqlRequestOutput | ExecuteRestRequestOutput
export type ExecutionFailure = ExecuteGraphqlRequestError | ExecuteRestRequestError

/** `ExecuteRestRequestOutput` não tem `graphqlErrors` (REST não tem erros
 * GraphQL) — `null` quando `result` é `undefined`/vem de uma execução REST. */
export function graphqlErrorsOf(result: ExecutionSuccess | null | undefined): GraphqlErrorOutput[] | null {
  if (!result || !('graphqlErrors' in result)) return null
  return result.graphqlErrors
}

export type ExecutionState =
  | { status: 'idle' }
  /** `startedAt`: `Date.now()` do envio — alimenta o contador ao vivo do painel de resposta. */
  | { status: 'loading'; startedAt: number }
  /** `responseNotStored`: envio reaberto do histórico que guardou só status, tempo e tamanho. */
  | { status: 'success'; result: ExecutionSuccess; responseNotStored?: boolean }
  | { status: 'error'; error: ExecutionFailure }

export type SchemaLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; schema: LoadSchemaOutput }
  | { status: 'error'; error: LoadSchemaError }

/** Uma aba aberta no workbench: buffer de edição e estado de execução/schema
 * independentes de qualquer outra aba aberta ao mesmo tempo. `requestId` é
 * `null` enquanto a aba é um rascunho ainda não salvo. */
/** Node de requisição avulsa de um flow (spec 0086) editado numa aba. */
export interface FlowNodeRef {
  flowId: string
  nodeId: string
}

export interface WorkbenchTab {
  id: string
  requestId: string | null
  /** Presente quando a aba edita a requisição de um node avulso de flow —
   * "Salvar" grava no node, não numa coleção. */
  flowNodeRef?: FlowNodeRef
  name: string
  /** `false` para uma requisição aberta em modo de pré-visualização: o
   * título fica em itálico e outra requisição pode substituí-la. Editar ou
   * dar duplo clique fixa a aba permanentemente durante a sessão. */
  pinned: boolean
  /** Aba fixada pelo usuário: aparece antes das demais na barra e sobrevive a
   * "excluir abas não fixadas". Gravada na sessão de abas. */
  fixed?: boolean
  endpointUrl: string
  activeSection: RequestTabId
  protocol: WorkbenchProtocol
  method: HttpMethodInput
  query: string
  variables: string
  /** Corpo de uma requisição REST — paralelo a `query`/`variables`, que só se aplicam a abas GraphQL. */
  body: BodyState
  /** Scripts JavaScript da requisição (spec 0054); vazio = sem script. */
  preRequestScript: string
  postResponseScript: string
  headers: HeaderEntry[]
  params: ParamEntry[]
  routeParams: RouteParamEntry[]
  authorization: AuthorizationState
  /** Conteúdo da requisição no último carregamento/salvamento da aba —
   * comparado ao conteúdo atual (campo a campo) para recalcular `dirty`. */
  savedContent: RequestContent
  /** `true` quando há alterações não salvas desde o último carregamento/
   * salvamento. Recalculado uma vez por edição (em `updateTab`, só para a
   * aba afetada) em vez de comparar `JSON.stringify` de todas as abas a
   * cada render. */
  dirty: boolean
  execution: ExecutionState
  executionId: string | null
  /** Id do envio que produziu a resposta exibida (o mesmo id da entrada no
   * histórico) — é o envio "atual" no histórico de envios. */
  lastSendId: string | null
  schema: SchemaLoadState
  schemaExecutionId: string | null
}
