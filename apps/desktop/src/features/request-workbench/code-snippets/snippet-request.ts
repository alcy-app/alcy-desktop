import type { AuthenticationInput } from '../../../bindings/execute-graphql-request'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { toAuthenticationInput } from '../authorization-state'
import { applyRouteParamValues } from '../query-params'
import { resolveTemplateForDisplay } from '../resolve-url'
import type { WorkbenchTab } from '../request-workbench.types'

export interface SnippetField {
  name: string
  value: string
}

export type SnippetFormField = { kind: 'text'; name: string; value: string } | { kind: 'file'; name: string; path: string }

export type SnippetBody =
  | { type: 'none' }
  | { type: 'text'; text: string }
  | { type: 'urlencoded'; fields: SnippetField[] }
  | { type: 'formData'; fields: SnippetFormField[] }
  | { type: 'file'; path: string }

/** Requisição já resolvida (variáveis, autenticação, corpo) e independente
 * de linguagem — é o que cada gerador de `generators.ts` transforma em código. */
export interface SnippetRequest {
  /** Método em maiúsculas (`GET`, `POST`…). */
  method: string
  url: string
  /** Headers habilitados, incluindo o de autenticação quando houver. */
  headers: SnippetField[]
  body: SnippetBody
  /** Digest não vira header: cada gerador usa o suporte nativo do cliente ou comenta. */
  digest: { username: string; password: string } | null
  /** Observações gerais que viram comentários no topo do código. */
  notes: string[]
}

/** Campos da aba usados para gerar o código. */
export type SnippetTab = Pick<
  WorkbenchTab,
  'protocol' | 'method' | 'endpointUrl' | 'query' | 'variables' | 'headers' | 'body' | 'routeParams' | 'authorization'
>

/** Base64 de um texto UTF-8 (o `btoa` puro só aceita Latin-1). */
function base64Utf8(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function graphqlBody(query: string, variables: string): string {
  let parsedVariables: unknown = undefined
  if (variables.trim()) {
    try {
      parsedVariables = JSON.parse(variables)
    } catch {
      parsedVariables = variables
    }
  }
  const payload = parsedVariables === undefined ? { query } : { query, variables: parsedVariables }
  return JSON.stringify(payload, null, 2)
}

export function buildSnippetRequest(
  tab: SnippetTab,
  inheritedAuthentication: AuthenticationInput | undefined,
  variables: EnvironmentVariableDto[],
): SnippetRequest {
  const resolve = (text: string) => resolveTemplateForDisplay(text, variables)
  const url =
    tab.protocol === 'rest'
      ? applyRouteParamValues(
          resolve(tab.endpointUrl.trim()),
          tab.routeParams.map(({ name, value }) => ({ name, value: resolve(value) })),
        )
      : resolve(tab.endpointUrl.trim())
  const notes: string[] = []
  let digest: SnippetRequest['digest'] = null

  let headers: SnippetField[] = tab.headers
    .filter((header) => header.enabled && header.name.trim())
    .map((header) => ({ name: header.name.trim(), value: resolve(header.value) }))
  const hasHeader = (name: string) => headers.some((header) => header.name.toLowerCase() === name.toLowerCase())
  const setHeader = (name: string, value: string) => {
    // A autenticação configurada tem precedência sobre um header manual com o mesmo nome.
    headers = headers.filter((header) => header.name.toLowerCase() !== name.toLowerCase())
    headers.push({ name, value })
  }

  let body: SnippetBody = { type: 'none' }
  if (tab.protocol === 'graphql') {
    body = { type: 'text', text: resolve(graphqlBody(tab.query, tab.variables)) }
    if (!hasHeader('content-type')) headers.push({ name: 'Content-Type', value: 'application/json' })
  } else {
    const source = tab.body
    switch (source.type) {
      case 'raw':
        if (source.raw) body = { type: 'text', text: resolve(source.raw) }
        break
      case 'urlencoded':
        body = {
          type: 'urlencoded',
          fields: source.urlEncoded
            .filter((field) => field.enabled && field.name)
            .map((field) => ({ name: resolve(field.name), value: resolve(field.value) })),
        }
        break
      case 'formData':
        body = {
          type: 'formData',
          fields: source.formData
            .filter((field) => field.enabled && field.name)
            .map((field): SnippetFormField =>
              field.kind === 'file'
                ? { kind: 'file', name: resolve(field.name), path: field.filePath }
                : { kind: 'text', name: resolve(field.name), value: resolve(field.value) },
            ),
        }
        // O header multipart com boundary é gerado pelo cliente; um fixo quebraria o envio.
        headers = headers.filter(
          (header) =>
            header.name.toLowerCase() !== 'content-type' || !header.value.toLowerCase().startsWith('multipart/form-data'),
        )
        break
      case 'binary':
        if (source.binaryFilePath) body = { type: 'file', path: source.binaryFilePath }
        break
      case 'none':
        break
    }
  }

  const ownAuthentication = toAuthenticationInput(tab.authorization)
  const authentication =
    ownAuthentication.type === 'inherit' ? (inheritedAuthentication ?? { type: 'none' }) : ownAuthentication
  switch (authentication.type) {
    case 'bearer':
      setHeader('Authorization', `Bearer ${resolve(authentication.token)}`)
      break
    case 'basic': {
      const credentials = `${resolve(authentication.username)}:${resolve(authentication.password)}`
      // Com placeholder de variável sensível, codificar esconderia o `{{nome}}` que o leitor precisa preencher.
      const encoded = credentials.includes('{{') ? credentials : base64Utf8(credentials)
      setHeader('Authorization', `Basic ${encoded}`)
      break
    }
    case 'customHeader':
      if (authentication.name.trim()) {
        setHeader(resolve(authentication.name.trim()), resolve(authentication.value))
      }
      break
    case 'digest':
      headers = headers.filter((header) => header.name.toLowerCase() !== 'authorization')
      digest = { username: resolve(authentication.username), password: resolve(authentication.password) }
      break
    case 'oauth2ClientCredentials':
      setHeader('Authorization', 'Bearer <access_token>')
      notes.push(
        `OAuth 2.0 client credentials: get an access token from ${resolve(authentication.tokenUrl) || 'the token URL'} and replace <access_token>.`,
      )
      break
    case 'none':
    case 'inherit':
      break
  }

  return {
    method: tab.protocol === 'graphql' ? 'POST' : tab.method.toUpperCase(),
    url,
    headers,
    body,
    digest,
    notes,
  }
}
