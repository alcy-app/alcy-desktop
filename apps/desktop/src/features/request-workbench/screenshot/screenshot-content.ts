import type { AuthenticationInput, ResponseHeader } from '../../../bindings/execute-graphql-request'
import type { RawBodyLanguage } from '../../../bindings/execute-rest-request'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { toAuthenticationInput } from '../authorization-state'
import { buildSnippetRequest, type SnippetBody, type SnippetTab } from '../code-snippets/snippet-request'
import { harRedactionContext, redactHeaders, type HarRedactionContext } from '../har-redaction'
import { formatJsonBody, formatPartialJsonBody } from '../json-format'
import { graphqlErrorsOf, httpResultOf, type ExecutionFailure, type ExecutionState } from '../request-workbench.types'

type HttpResult = NonNullable<ReturnType<typeof httpResultOf>>
import { resolveTemplateForDisplay } from '../resolve-url'
import { detectBodyMode } from '../response-body-mode'
import { formatSize, statusTone, type StatusTone } from '../response-summary'
import type { HighlightLanguage } from './screenshot-highlight'
import { lineLimitValue, type ScreenshotOptions } from './screenshot-options'

export interface ScreenshotRow {
  name: string
  value: string
}

export interface ScreenshotCodeBlock {
  kind: 'code'
  label: string | null
  language: HighlightLanguage
  lines: string[]
  /** Linhas cortadas pelo limite de linhas por corpo. */
  omittedLines: number
  /** Aviso sob o bloco (ex.: só a prévia de um corpo grande entrou). */
  note: string | null
}

export interface ScreenshotTableBlock {
  kind: 'table'
  label: string | null
  rows: ScreenshotRow[]
}

export type ScreenshotBlock = ScreenshotCodeBlock | ScreenshotTableBlock

export interface ScreenshotStatus {
  statusCode: number
  tone: StatusTone
  /** Resultado GraphQL (`null` em REST). */
  graphql: 'success' | 'error' | null
  duration: string
  size: string
}

export type ScreenshotResponse =
  | { kind: 'success'; status: ScreenshotStatus | null; headers: ScreenshotRow[] | null; body: ScreenshotBlock | null }
  | { kind: 'error'; message: string }

/** Tudo o que a imagem mostra, já resolvido, ocultado e cortado — o layout
 * (`screenshot-layout.ts`) só posiciona. `null` = seção fora da imagem. */
export interface ScreenshotContent {
  header: { title: string; environment: string | null; capturedAt: string } | null
  endpoint: { method: string; url: string } | null
  request: { headers: ScreenshotRow[] | null; body: ScreenshotBlock[] | null } | null
  response: ScreenshotResponse | null
}

export interface ScreenshotSource {
  tab: SnippetTab
  execution: ExecutionState
  /** Autenticação efetiva da coleção/pasta, usada quando a aba herda (`inherit`). */
  inheritedAuthentication: AuthenticationInput | undefined
  environmentVariables: EnvironmentVariableDto[]
  requestName: string
  environmentName: string | null
}

/** Textos traduzidos que entram no conteúdo. */
export interface ScreenshotContentText {
  capturedAt: string
  errorMessage: (error: ExecutionFailure) => string
  binaryBody: (size: string) => string
  emptyBody: string
  previewOnly: (shown: string, total: string) => string
  file: (path: string) => string
}

const RAW_LANGUAGES: Record<RawBodyLanguage, HighlightLanguage> = {
  text: 'text',
  javascript: 'javascript',
  json: 'json',
  html: 'html',
  xml: 'xml',
}

function codeBlock(
  label: string | null,
  language: HighlightLanguage,
  source: string,
  limit: number,
  note: string | null = null,
): ScreenshotCodeBlock {
  // Tab no canvas não tem largura previsível; o editor indenta com 2 espaços.
  const all = source.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')
  if (all.length > 1 && all[all.length - 1] === '') all.pop()
  const lines = all.slice(0, limit)
  return { kind: 'code', label, language, lines, omittedLines: all.length - lines.length, note }
}

/** JSON sempre formatado: minificado, viraria uma linha só quebrada na largura do cartão. */
function formatIfJson(text: string, language: HighlightLanguage): string {
  return language === 'json' ? formatJsonBody(text) : text
}

function requestBodyBlocks(
  source: ScreenshotSource,
  snippetBody: SnippetBody,
  variables: EnvironmentVariableDto[],
  options: ScreenshotOptions,
  text: ScreenshotContentText,
): ScreenshotBlock[] | null {
  const limit = lineLimitValue(options.lineLimit)
  const { tab } = source
  if (tab.protocol === 'graphql') {
    const blocks: ScreenshotBlock[] = []
    if (tab.query.trim()) blocks.push(codeBlock('Query', 'graphql', resolveTemplateForDisplay(tab.query, variables), limit))
    if (tab.variables.trim()) {
      const resolved = resolveTemplateForDisplay(tab.variables, variables)
      blocks.push(codeBlock('Variables', 'json', formatJsonBody(resolved), limit))
    }
    return blocks.length > 0 ? blocks : null
  }
  switch (snippetBody.type) {
    case 'none':
      return null
    case 'text': {
      const language = RAW_LANGUAGES[tab.body.rawLanguage]
      return [codeBlock('Body', language, formatIfJson(snippetBody.text, language), limit)]
    }
    case 'urlencoded':
      return snippetBody.fields.length > 0 ? [{ kind: 'table', label: 'Body', rows: snippetBody.fields }] : null
    case 'formData':
      return snippetBody.fields.length > 0
        ? [
            {
              kind: 'table',
              label: 'Body',
              rows: snippetBody.fields.map((field) => ({
                name: field.name,
                value: field.kind === 'file' ? text.file(field.path) : field.value,
              })),
            },
          ]
        : null
    case 'file':
      return [codeBlock('Body', 'text', text.file(snippetBody.path), limit)]
  }
}

function responseBodyBlock(result: HttpResult, options: ScreenshotOptions, text: ScreenshotContentText): ScreenshotBlock {
  const limit = lineLimitValue(options.lineLimit)
  if (result.bodyEncoding === 'base64') return codeBlock(null, 'text', text.binaryBody(formatSize(result.sizeBytes)), limit)

  const { body } = result
  // Só a prévia de um corpo grande: nada volta a cruzar a IPC, e o limite de linhas já corta antes do fim dela.
  const raw = body.kind === 'inline' ? body.body : body.preview
  const partialEnd = body.kind === 'windowed' ? body.previewNextOffset : null
  if (raw === '') return codeBlock(null, 'text', text.emptyBody, limit)

  const mode = detectBodyMode(result.headers, raw)
  const formatted =
    mode === 'json' ? (partialEnd === null ? formatJsonBody(raw) : formatPartialJsonBody(raw)) : raw
  const note =
    body.kind === 'windowed' && partialEnd !== null ? text.previewOnly(formatSize(partialEnd), formatSize(body.totalBytes)) : null
  return codeBlock(null, mode, formatted, limit, note)
}

function screenshotStatus(result: HttpResult): ScreenshotStatus {
  const graphqlErrors = graphqlErrorsOf(result)
  return {
    statusCode: result.statusCode,
    tone: statusTone(result.statusCode),
    graphql: graphqlErrors === null ? null : graphqlErrors.length > 0 ? 'error' : 'success',
    duration: `${result.durationMs} ms`,
    size: formatSize(result.sizeBytes),
  }
}

function rows(headers: ResponseHeader[], direction: 'request' | 'response', redaction: HarRedactionContext | null) {
  const visible = redaction ? redactHeaders(headers, direction, redaction) : headers
  return visible.length > 0 ? visible : null
}

function buildResponse(
  execution: ExecutionState,
  options: ScreenshotOptions,
  redaction: HarRedactionContext | null,
  text: ScreenshotContentText,
): ScreenshotResponse | null {
  const { fields } = options
  if (!fields.status && !fields.responseHeaders && !fields.responseBody) return null
  if (execution.status === 'error') return { kind: 'error', message: text.errorMessage(execution.error) }
  if (execution.status !== 'success') return null
  // gRPC responses are not part of the image yet (spec 0129).
  const result = httpResultOf(execution.result)
  if (!result) return null
  return {
    kind: 'success',
    status: fields.status ? screenshotStatus(result) : null,
    headers: fields.responseHeaders ? rows(result.headers, 'response', redaction) : null,
    body: fields.responseBody ? responseBodyBlock(result, options, text) : null,
  }
}

/**
 * Monta o conteúdo da imagem de compartilhamento a partir da aba e da última
 * execução. A requisição reaproveita `buildSnippetRequest` (variáveis
 * resolvidas, autenticação nos headers); com "ocultar dados sensíveis",
 * variáveis sensíveis ficam como `{{nome}}` e credenciais nos headers são
 * mascaradas com as regras do HAR. Sem essa opção, tudo aparece resolvido.
 */
export function buildScreenshotContent(
  source: ScreenshotSource,
  options: ScreenshotOptions,
  text: ScreenshotContentText,
): ScreenshotContent {
  const { fields, hideSensitive } = options
  const { tab, execution } = source
  const variables = hideSensitive
    ? source.environmentVariables
    : source.environmentVariables.map((variable) => ({ ...variable, sensitive: false }))
  const snippet = buildSnippetRequest(tab, source.inheritedAuthentication, variables)

  const ownAuthentication = toAuthenticationInput(tab.authorization)
  const authentication = ownAuthentication.type === 'inherit' ? source.inheritedAuthentication : ownAuthentication
  const success = execution.status === 'success' ? httpResultOf(execution.result) : null
  const redaction = hideSensitive
    ? harRedactionContext(source.environmentVariables, (success?.environmentChanges ?? []).filter((change): change is { name: string; value: string } => change.value !== null), authentication)
    : null

  // Os headers enviados de fato (com os que a autenticação injeta) valem mais como evidência que os configurados.
  const requestHeaders = fields.requestHeaders ? rows(success ? success.requestHeaders : snippet.headers, 'request', redaction) : null
  const requestBody = fields.requestBody ? requestBodyBlocks(source, snippet.body, variables, options, text) : null

  return {
    header: fields.header
      ? { title: source.requestName, environment: source.environmentName, capturedAt: text.capturedAt }
      : null,
    endpoint: fields.url ? { method: snippet.method, url: snippet.url } : null,
    request: requestHeaders || requestBody ? { headers: requestHeaders, body: requestBody } : null,
    response: buildResponse(execution, options, redaction, text),
  }
}

export function isScreenshotEmpty(content: ScreenshotContent): boolean {
  return !content.header && !content.endpoint && !content.request && !content.response
}
