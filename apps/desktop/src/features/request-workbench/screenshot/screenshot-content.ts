import type { AuthenticationInput, ResponseHeader } from '../../../bindings/execute-graphql-request'
import type { RawBodyLanguage } from '../../../bindings/execute-rest-request'
import type { ExecuteGrpcRequestOutput } from '../../../bindings/execute-grpc-request'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { toAuthenticationInput } from '../authorization-state'
import { buildSnippetRequest, type SnippetBody, type SnippetTab } from '../code-snippets/snippet-request'
import { harRedactionContext, redactHeaders, type HarRedactionContext } from '../har-redaction'
import { formatJsonBody, formatPartialJsonBody } from '../json-format'
import { graphqlErrorsOf, grpcResultOf, httpResultOf, websocketResultOf, type ExecutionFailure, type ExecutionState } from '../request-workbench.types'
import type { ExecuteWebSocketRequestOutput } from '../../../bindings/execute-websocket-request'

type HttpResult = NonNullable<ReturnType<typeof httpResultOf>>
import { resolveTemplateForDisplay } from '../resolve-url'
import { detectBodyMode } from '../response-body-mode'
import { formatSize, statusTone, type StatusTone } from '../response-summary'
import { excerptLastLine, type ResponseExcerpt } from './response-excerpt'
import type { HighlightLanguage, HighlightSpan } from './screenshot-highlight'
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
  /** Number shown beside `lines[0]` (1 unless the block is an excerpt). */
  firstLineNumber?: number
  /** Colors already computed for `lines`; otherwise the layout highlights them by `language`. */
  spans?: HighlightSpan[][]
  /** Lines omitted by the per-body line limit. */
  omittedLines: number
  /** Note below the block, such as a large-body preview notice. */
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
  grpc?: { codeName: string; message: string }
  tone: StatusTone
  /** GraphQL outcome (`null` for REST and gRPC). */
  graphql: 'success' | 'error' | null
  duration: string
  size: string
}

export type ScreenshotResponse =
  | { kind: 'success'; status: ScreenshotStatus | null; headers: ScreenshotRow[] | null; body: ScreenshotBlock | null; trailers?: ScreenshotRow[] | null }
  | { kind: 'error'; message: string }

/** Resolved, redacted and bounded image content. The layout only positions it.
 * A null section is excluded from the image. */
export interface ScreenshotContent {
  header: { title: string; environment: string | null; capturedAt: string } | null
  endpoint: { method: string; url: string; rpc?: string } | null
  request: { headers: ScreenshotRow[] | null; body: ScreenshotBlock[] | null } | null
  response: ScreenshotResponse | null
}

export interface ScreenshotSource {
  tab: SnippetTab
  execution: ExecutionState
  /** Effective collection/folder authentication for tabs using `inherit`. */
  inheritedAuthentication: AuthenticationInput | undefined
  environmentVariables: EnvironmentVariableDto[]
  requestName: string
  environmentName: string | null
  /** Response lines the user selected: the image shows only them, without request data. */
  excerpt?: ResponseExcerpt | null
}

/** Translated text used in image content. */
export interface ScreenshotContentText {
  capturedAt: string
  errorMessage: (error: ExecutionFailure) => string
  binaryBody: (size: string) => string
  emptyBody: string
  previewOnly: (shown: string, total: string) => string
  file: (path: string) => string
  /** Label of an excerpt block, from its first and last line numbers. */
  excerptLabel: (first: number, last: number) => string
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
  // Canvas tabs have no predictable width; the editor uses two-space indentation.
  const all = source.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')
  if (all.length > 1 && all[all.length - 1] === '') all.pop()
  const lines = all.slice(0, limit)
  return { kind: 'code', label, language, lines, omittedLines: all.length - lines.length, note }
}

/** Pretty-print JSON so minified bodies do not become a single wrapped line. */
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
  if (tab.protocol === 'grpc') {
    return snippetBody.type === 'text' ? [codeBlock('Message', 'json', formatJsonBody(snippetBody.text), limit)] : null
  }
  if (tab.protocol === 'websocket') {
    if (snippetBody.type !== 'text') return null
    const json = tab.websocket?.messageFormat === 'json'
    return [codeBlock('Message', json ? 'json' : 'text', json ? formatJsonBody(snippetBody.text) : snippetBody.text, limit)]
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

function excerptBlock(excerpt: ResponseExcerpt, text: ScreenshotContentText): ScreenshotCodeBlock {
  const lines = excerpt.lines.slice(0, lineLimitValue('all'))
  return {
    kind: 'code',
    label: text.excerptLabel(excerpt.firstLine, excerptLastLine(excerpt)),
    language: excerpt.language,
    lines,
    firstLineNumber: excerpt.firstLine,
    spans: excerpt.spans.slice(0, lines.length),
    omittedLines: excerpt.lines.length - lines.length,
    note: null,
  }
}

function responseBodyBlock(result: HttpResult | ExecuteGrpcRequestOutput | ExecuteWebSocketRequestOutput, options: ScreenshotOptions, text: ScreenshotContentText): ScreenshotBlock {
  const limit = lineLimitValue(options.lineLimit)
  if ('bodyEncoding' in result && result.bodyEncoding === 'base64') return codeBlock(null, 'text', text.binaryBody(formatSize(result.sizeBytes)), limit)

  const { body } = result
  // Use the bounded body preview without fetching more data through IPC.
  const raw = body.kind === 'inline' ? body.body : body.preview
  const partialEnd = body.kind === 'windowed' ? body.previewNextOffset : null
  if (raw === '') return codeBlock(null, 'text', text.emptyBody, limit)

  const mode = 'status' in result ? 'json' : detectBodyMode(result.headers, raw)
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

function metadataRows(headers: ResponseHeader[], redaction: HarRedactionContext | null) {
  const visible = redaction ? redactHeaders(headers, 'request', redaction) : headers
  return rows(visible, 'response', redaction)
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
  const grpc = grpcResultOf(execution.result)
  if (grpc) return {
    kind: 'success',
    status: fields.status ? {
      statusCode: grpc.status.code,
      grpc: { codeName: grpc.status.codeName, message: grpc.status.message },
      tone: grpc.status.code === 0 ? 'success' : 'error',
      graphql: null,
      duration: `${grpc.durationMs} ms`,
      size: formatSize(grpc.sizeBytes),
    } : null,
    headers: fields.responseHeaders ? metadataRows(grpc.headers, redaction) : null,
    trailers: fields.responseHeaders ? metadataRows(grpc.trailers, redaction) : null,
    body: fields.responseBody ? responseBodyBlock(grpc, options, text) : null,
  }
  const websocket = websocketResultOf(execution.result)
  if (websocket) {
    const { close } = websocket
    const clean = close.closedBy === 'client' || (close.closedBy === 'server' && (close.code === null || close.code === 1000 || close.code === 1001))
    return {
      kind: 'success',
      status: fields.status ? {
        statusCode: websocket.statusCode,
        tone: close.closedBy === 'rejected' ? statusTone(websocket.statusCode) : clean ? 'success' : 'error',
        graphql: null,
        duration: `${websocket.durationMs} ms`,
        size: formatSize(websocket.sizeBytes),
      } : null,
      headers: fields.responseHeaders ? rows(websocket.headers, 'response', redaction) : null,
      body: fields.responseBody ? responseBodyBlock(websocket, options, text) : null,
    }
  }
  const result = httpResultOf(execution.result)
  if (!result) return null
  return {
    kind: 'success',
    status: fields.status ? screenshotStatus(result) : null,
    headers: fields.responseHeaders ? rows(result.headers, 'response', redaction) : null,
    body: fields.responseBody ? responseBodyBlock(result, options, text) : null,
  }
}

/** The response card around an excerpt: its status when enabled, then the selected lines. */
function excerptResponse(
  execution: ExecutionState,
  excerpt: ResponseExcerpt,
  options: ScreenshotOptions,
  redaction: HarRedactionContext | null,
  text: ScreenshotContentText,
): ScreenshotResponse {
  const response = options.fields.status ? buildResponse(execution, options, redaction, text) : null
  const status = response?.kind === 'success' ? response.status : null
  return { kind: 'success', status, headers: null, body: excerptBlock(excerpt, text) }
}

/** Builds image content from the tab and its last execution. Request data
 * reuses the code-sharing resolver. When hiding sensitive data, sensitive
 * variables remain as placeholders and credential headers use HAR redaction. */
export function buildScreenshotContent(
  source: ScreenshotSource,
  options: ScreenshotOptions,
  text: ScreenshotContentText,
): ScreenshotContent {
  const { hideSensitive } = options
  const { tab, execution, excerpt } = source
  // An excerpt replaces the bodies and headers; only its context fields still apply.
  const fields = excerpt
    ? { ...options.fields, requestHeaders: false, requestBody: false, responseHeaders: false, responseBody: false }
    : options.fields
  const variables = hideSensitive
    ? source.environmentVariables
    : source.environmentVariables.map((variable) => ({ ...variable, sensitive: false }))
  const snippet = buildSnippetRequest(tab, source.inheritedAuthentication, variables)

  const ownAuthentication = toAuthenticationInput(tab.authorization)
  const authentication = ownAuthentication.type === 'inherit' ? source.inheritedAuthentication : ownAuthentication
  const success = execution.status === 'success' ? execution.result : null
  const httpSuccess = success ? httpResultOf(success) : null
  const redaction = hideSensitive
    ? harRedactionContext(source.environmentVariables, (success?.environmentChanges ?? []).filter((change): change is { name: string; value: string } => change.value !== null), authentication)
    : null

  // Prefer actual sent HTTP headers, including injected authentication, when available.
  const requestHeaders = fields.requestHeaders ? rows(httpSuccess ? httpSuccess.requestHeaders : snippet.headers, 'request', redaction) : null
  const requestBody = fields.requestBody ? requestBodyBlocks(source, snippet.body, variables, options, text) : null

  return {
    header: fields.header
      ? { title: source.requestName, environment: source.environmentName, capturedAt: text.capturedAt }
      : null,
    endpoint: fields.url ? {
      method: tab.protocol === 'grpc' ? 'gRPC' : tab.protocol === 'websocket' ? 'WS' : snippet.method,
      url: snippet.url,
      ...(snippet.grpc ? { rpc: [snippet.grpc.service, snippet.grpc.method].filter(Boolean).join('/') } : {}),
    } : null,
    request: requestHeaders || requestBody ? { headers: requestHeaders, body: requestBody } : null,
    response: excerpt ? excerptResponse(execution, excerpt, { ...options, fields }, redaction, text) : buildResponse(execution, options, redaction, text),
  }
}

export function isScreenshotEmpty(content: ScreenshotContent): boolean {
  return !content.header && !content.endpoint && !content.request && !content.response
}
