import type { AuthenticationInput, HeaderInput } from '../../../bindings/execute-graphql-request'
import type { CollectionDto, SavedRequestDto } from '../../../bindings/list-collections'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { toAuthenticationInput } from '../authorization-state'
import { restBodyText, toRestBodyInput } from '../body-state'
import { emptyGrpcCall } from '../collection-tree'
import type { SnippetTab } from '../code-snippets/snippet-request'
import { isCredentialHeader } from '../har-redaction'
import { parseQueryParams } from '../query-params'

/** PNG text keyword recognized by the native image importer (ADR 0032). */
export const IMPORT_PNG_KEYWORD = 'alcy.collections'

const TEMPLATE_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g

export interface ImportMetadataInput {
  tab: SnippetTab
  inheritedAuthentication: AuthenticationInput | undefined
  requestName: string
  hideSensitive: boolean
}

export interface ImportMetadataPasswordSuspicionInput {
  tab: SnippetTab
  inheritedAuthentication: AuthenticationInput | undefined
  environmentVariables: EnvironmentVariableDto[]
}

export interface ClearedImportMetadataSource {
  tab: SnippetTab
  inheritedAuthentication: AuthenticationInput | undefined
}

const SUSPICIOUS_FIELD_PATTERN = /\b(?:password|passwd|pwd|passphrase|senha|secret|token|api\s*key|credential)\b/i

function isSuspiciousFieldName(name: string): boolean {
  const words = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[^a-z\d]+/gi, ' ')
  return SUSPICIOUS_FIELD_PATTERN.test(words)
}

function isFilled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== ''
  return value !== null && value !== undefined
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function hasSensitiveVariableReference(value: string, environmentVariables: EnvironmentVariableDto[]): boolean {
  return environmentVariables
    .filter(({ sensitive }) => sensitive)
    .some(({ name }) => {
      const reference = new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`)
      return reference.test(value)
    })
}

function hasSensitiveVariableValue(value: string, environmentVariables: EnvironmentVariableDto[]): boolean {
  return environmentVariables
    .filter(({ sensitive }) => sensitive)
    .some(({ value: sensitiveValue }) => {
      if (!sensitiveValue) return false
      return value === sensitiveValue || (sensitiveValue.length >= 4 && value.includes(sensitiveValue))
    })
}

function hasUnprotectedSuspectedValue(value: string, environmentVariables: EnvironmentVariableDto[]): boolean {
  return isFilled(value) && !hasSensitiveVariableReference(value, environmentVariables)
}

function shouldClearNamedValue(name: string, value: string, environmentVariables: EnvironmentVariableDto[]): boolean {
  return (
    hasSensitiveVariableValue(value, environmentVariables) ||
    (isSuspiciousFieldName(name) && hasUnprotectedSuspectedValue(value, environmentVariables))
  )
}

function jsonHasSuspiciousField(value: unknown, environmentVariables: EnvironmentVariableDto[]): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonHasSuspiciousField(item, environmentVariables))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([name, fieldValue]) =>
      (typeof fieldValue === 'string' && shouldClearNamedValue(name, fieldValue, environmentVariables)) ||
      (isSuspiciousFieldName(name) && isFilled(fieldValue) && typeof fieldValue !== 'string') ||
      jsonHasSuspiciousField(fieldValue, environmentVariables),
  )
}

function textHasSuspiciousField(text: string, environmentVariables: EnvironmentVariableDto[]): boolean {
  if (!text.trim()) return false
  try {
    return jsonHasSuspiciousField(JSON.parse(text), environmentVariables)
  } catch {
    // Handle GraphQL, XML and incomplete bodies without requiring valid JSON:
    // `password: value`, `password=value` and `<password>value`.
    const normalized = text.replace(/([a-z\d])([A-Z])/g, '$1 $2')
    if (hasSensitiveVariableReference(normalized, environmentVariables)) return false
    return /(?:password|passwd|pwd|passphrase|senha|secret|token|api[-_ ]?key|credential)\s*(?:["']?\s*[:=]\s*["']?\s*[^\s,}\]&<]|>\s*[^\s<])/i.test(
      normalized,
    )
  }
}

function graphqlHasSuspiciousArgument(query: string, environmentVariables: EnvironmentVariableDto[]): boolean {
  const normalized = query.replace(/([a-z\d])([A-Z])/g, '$1 $2')
  return [...normalized.matchAll(/(?<![$\w])(?:password|passwd|pwd|passphrase|senha|secret|token|api[-_ ]?key|credential)\s*:\s*(?<value>"(?:\\.|[^"])+"|'(?:\\.|[^'])+'|-?\d+|true\b|false\b)/gi)].some(
    (match) => !hasSensitiveVariableReference(match.groups?.value ?? '', environmentVariables),
  )
}

function authenticationSecretValues(authentication: AuthenticationInput): string[] {
  switch (authentication.type) {
    case 'bearer':
      return [authentication.token]
    case 'basic':
    case 'digest':
      return [authentication.password]
    case 'oauth2ClientCredentials':
      return [authentication.clientSecret]
    case 'customHeader':
      return [authentication.value]
    case 'none':
    case 'inherit':
      return []
  }
}

/** Detects likely credentials in the embedded request to guide user review,
 * using field names and sensitive variable values or references. */
export function hasSuspectedPasswordInImportMetadata({
  tab,
  inheritedAuthentication,
  environmentVariables,
}: ImportMetadataPasswordSuspicionInput): boolean {
  const ownAuthentication = toAuthenticationInput(tab.authorization)
  const authentication =
    ownAuthentication.type === 'inherit' ? (inheritedAuthentication ?? { type: 'none' }) : ownAuthentication
  if (authenticationSecretValues(authentication).some((value) => hasUnprotectedSuspectedValue(value, environmentVariables))) return true

  const customHeaderNames = authentication.type === 'customHeader' ? [authentication.name.trim()] : []
  if (
    tab.headers.some(
      ({ name, value }) =>
        shouldClearNamedValue(name, value, environmentVariables) ||
        (isCredentialHeader(name.trim(), customHeaderNames) && hasUnprotectedSuspectedValue(value, environmentVariables)),
    )
  ) {
    return true
  }

  const namedValues: Array<{ name: string; value: string }> = [
    ...parseQueryParams(tab.endpointUrl),
    ...tab.routeParams.map(({ name, value }) => ({ name, value })),
  ]
  if (tab.protocol === 'rest') {
    if (tab.body.type === 'urlencoded') namedValues.push(...tab.body.urlEncoded)
    if (tab.body.type === 'formData') {
      namedValues.push(
        ...tab.body.formData
          .filter((field) => field.kind === 'text')
          .map(({ name, value }) => ({ name, value })),
      )
    }
  }
  if (namedValues.some(({ name, value }) => shouldClearNamedValue(name, value, environmentVariables))) return true

  const authoredText = [
    tab.endpointUrl,
    tab.query,
    tab.variables,
    ...tab.headers.flatMap(({ name, value }) => [name, value]),
    ...tab.routeParams.flatMap(({ name, value }) => [name, value]),
    ...authenticationSecretValues(authentication),
  ]
  if (tab.protocol === 'grpc' && tab.grpc) {
    authoredText.push(tab.grpc.service, tab.grpc.method, tab.grpc.message)
    if (textHasSuspiciousField(tab.grpc.message, environmentVariables)) return true
  }
  if (tab.protocol === 'rest') {
    if (tab.body.type === 'raw') authoredText.push(tab.body.raw)
    if (tab.body.type === 'urlencoded') authoredText.push(...tab.body.urlEncoded.flatMap(({ name, value }) => [name, value]))
    if (tab.body.type === 'formData') {
      authoredText.push(...tab.body.formData.flatMap((field) => [field.name, field.kind === 'text' ? field.value : '']))
    }
  }

  if (
    graphqlHasSuspiciousArgument(tab.query, environmentVariables) ||
    [tab.variables, tab.protocol === 'rest' && tab.body.type === 'raw' ? tab.body.raw : ''].some((text) =>
      textHasSuspiciousField(text, environmentVariables),
    )
  ) {
    return true
  }

  return authoredText.some((fieldValue) => hasSensitiveVariableValue(fieldValue, environmentVariables))
}

function clearSensitiveJson(value: unknown, environmentVariables: EnvironmentVariableDto[]): unknown {
  if (Array.isArray(value)) return value.map((item) => clearSensitiveJson(item, environmentVariables))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, fieldValue]) => [
        name,
        typeof fieldValue === 'string' && shouldClearNamedValue(name, fieldValue, environmentVariables)
          ? ''
          : isSuspiciousFieldName(name) && isFilled(fieldValue) && typeof fieldValue !== 'string'
          ? ''
          : clearSensitiveJson(fieldValue, environmentVariables),
      ]),
    )
  }
  if (typeof value === 'string' && hasSensitiveVariableValue(value, environmentVariables)) return ''
  return value
}

function clearSensitiveText(text: string, environmentVariables: EnvironmentVariableDto[]): string {
  if (!text.trim()) return text
  try {
    return JSON.stringify(clearSensitiveJson(JSON.parse(text), environmentVariables))
  } catch {
    let result = text
    for (const { value, sensitive } of environmentVariables) {
      if (!sensitive) continue
      if (value.length >= 4) result = result.split(value).join('')
    }
    result = result.replace(
      /((?:password|passwd|pwd|passphrase|senha|secret|token|api[-_ ]?key|credential)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,}\]&<]+)/gi,
      (match, prefix, value) => (hasSensitiveVariableReference(value, environmentVariables) ? match : `${prefix}""`),
    )
    return result.replace(
      /(<(?:password|passwd|pwd|passphrase|senha|secret|token|api[-_ ]?key|credential)\b[^>]*>)[^<]*(<\/[^>]+>)/gi,
      '$1$2',
    )
  }
}

function clearSensitiveGraphqlQuery(query: string, environmentVariables: EnvironmentVariableDto[]): string {
  let result = query
  for (const { value, sensitive } of environmentVariables) {
    if (!sensitive) continue
      if (value.length >= 4) result = result.split(value).join('')
  }
  return result.replace(
    /((?<![$\w])(?:password|passwd|pwd|passphrase|senha|secret|token|api[-_ ]?key|credential)\s*:\s*)("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|-?\d+(?:\.\d+)?|true\b|false\b|null\b)/gi,
    (match, prefix, value) => (hasSensitiveVariableReference(value, environmentVariables) ? match : `${prefix}""`),
  )
}

function clearAuthentication(
  authentication: AuthenticationInput | undefined,
  environmentVariables: EnvironmentVariableDto[],
): AuthenticationInput | undefined {
  if (!authentication) return undefined
  switch (authentication.type) {
    case 'bearer':
      return hasUnprotectedSuspectedValue(authentication.token, environmentVariables) ? { ...authentication, token: '' } : authentication
    case 'basic':
    case 'digest':
      return hasUnprotectedSuspectedValue(authentication.password, environmentVariables)
        ? { ...authentication, password: '' }
        : authentication
    case 'oauth2ClientCredentials':
      return hasUnprotectedSuspectedValue(authentication.clientSecret, environmentVariables)
        ? { ...authentication, clientSecret: '' }
        : authentication
    case 'customHeader':
      return hasUnprotectedSuspectedValue(authentication.value, environmentVariables) ? { ...authentication, value: '' } : authentication
    case 'none':
    case 'inherit':
      return authentication
  }
}

function clearEndpointQuery(endpointUrl: string, environmentVariables: EnvironmentVariableDto[]): string {
  const queryIndex = endpointUrl.indexOf('?')
  if (queryIndex < 0) return endpointUrl
  const fragmentIndex = endpointUrl.indexOf('#', queryIndex)
  const suffix = fragmentIndex < 0 ? '' : endpointUrl.slice(fragmentIndex)
  const queryEnd = fragmentIndex < 0 ? endpointUrl.length : fragmentIndex
  const query = endpointUrl
    .slice(queryIndex + 1, queryEnd)
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=')
      if (separator < 0) return pair
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      return shouldClearNamedValue(name, value, environmentVariables) ? `${name}=` : pair
    })
    .join('&')
  return `${endpointUrl.slice(0, queryIndex)}?${query}${suffix}`
}

/** Clears suspected credentials in a copy used only for embedded metadata.
 * The original draft remains unchanged and is still used to draw the image. */
export function clearSuspectedPasswordsForImport({
  tab,
  inheritedAuthentication,
  environmentVariables,
}: ImportMetadataPasswordSuspicionInput): ClearedImportMetadataSource {
  const ownAuthentication = toAuthenticationInput(tab.authorization)
  const effectiveAuthentication =
    ownAuthentication.type === 'inherit' ? (inheritedAuthentication ?? { type: 'none' }) : ownAuthentication
  const customHeaderNames = effectiveAuthentication.type === 'customHeader' ? [effectiveAuthentication.name.trim()] : []
  const authorization = { ...tab.authorization }
  if (authorization.type === 'bearer' && hasUnprotectedSuspectedValue(authorization.token, environmentVariables)) authorization.token = ''
  if (
    (authorization.type === 'basic' || authorization.type === 'digest') &&
    hasUnprotectedSuspectedValue(authorization.password, environmentVariables)
  ) {
    authorization.password = ''
  }
  if (
    authorization.type === 'oauth2ClientCredentials' &&
    hasUnprotectedSuspectedValue(authorization.clientSecret, environmentVariables)
  ) {
    authorization.clientSecret = ''
  }
  if (authorization.type === 'customHeader' && hasUnprotectedSuspectedValue(authorization.headerValue, environmentVariables)) {
    authorization.headerValue = ''
  }

  const headers = tab.headers.map((header) => ({
    ...header,
    value:
      shouldClearNamedValue(header.name, header.value, environmentVariables) ||
      (isCredentialHeader(header.name.trim(), customHeaderNames) &&
        hasUnprotectedSuspectedValue(header.value, environmentVariables))
        ? ''
        : header.value,
  }))
  const routeParams = tab.routeParams.map((parameter) => ({
    ...parameter,
    value:
      shouldClearNamedValue(parameter.name, parameter.value, environmentVariables)
        ? ''
        : parameter.value,
  }))
  let body = tab.body
  if (body.type === 'raw') body = { ...body, raw: clearSensitiveText(body.raw, environmentVariables) }
  if (body.type === 'urlencoded') {
    body = {
      ...body,
      urlEncoded: body.urlEncoded.map((field) => ({
        ...field,
        value:
          shouldClearNamedValue(field.name, field.value, environmentVariables) ? '' : field.value,
      })),
    }
  }
  if (body.type === 'formData') {
    body = {
      ...body,
      formData: body.formData.map((field) => ({
        ...field,
        value:
          field.kind === 'text' &&
          shouldClearNamedValue(field.name, field.value, environmentVariables)
            ? ''
            : field.value,
      })),
    }
  }

  return {
    tab: {
      ...tab,
      endpointUrl: clearEndpointQuery(tab.endpointUrl, environmentVariables),
      query: clearSensitiveGraphqlQuery(tab.query, environmentVariables),
      variables: clearSensitiveText(tab.variables, environmentVariables),
      headers,
      routeParams,
      body,
      authorization,
      ...(tab.protocol === 'grpc' && tab.grpc
        ? { grpc: { ...tab.grpc, message: clearSensitiveText(tab.grpc.message, environmentVariables) } } : {}),
    },
    inheritedAuthentication:
      ownAuthentication.type === 'inherit' ? clearAuthentication(inheritedAuthentication, environmentVariables) : inheritedAuthentication,
  }
}

/** Detects literal secrets beyond variable placeholders and authentication schemes. */
function hasLiteralSecret(value: string): boolean {
  return (
    value
      .replace(TEMPLATE_PATTERN, '')
      .replace(/^\s*[A-Za-z]+\s+/, '')
      .trim() !== ''
  )
}

const withoutLiteralSecret = (value: string) => (hasLiteralSecret(value) ? '' : value)

function redactAuthentication(authentication: AuthenticationInput): AuthenticationInput {
  switch (authentication.type) {
    case 'bearer':
      return { ...authentication, token: withoutLiteralSecret(authentication.token) }
    case 'basic':
    case 'digest':
      return { ...authentication, password: withoutLiteralSecret(authentication.password) }
    case 'oauth2ClientCredentials':
      return { ...authentication, clientSecret: withoutLiteralSecret(authentication.clientSecret) }
    case 'customHeader':
      return { ...authentication, value: withoutLiteralSecret(authentication.value) }
    case 'none':
    case 'inherit':
      return authentication
  }
}

/** Embeds the authored request and effective authentication as a collection.
 * Variable references are resolved by the importing workspace. Scripts are
 * excluded; `hideSensitive` removes literal authentication/header secrets. */
export function buildImportCollection({
  tab,
  inheritedAuthentication,
  requestName,
  hideSensitive,
}: ImportMetadataInput): CollectionDto {
  const ownAuthentication = toAuthenticationInput(tab.authorization)
  let authentication =
    ownAuthentication.type === 'inherit' ? (inheritedAuthentication ?? { type: 'none' }) : ownAuthentication
  let headers: HeaderInput[] = tab.headers.map(({ name, value, enabled }) => ({ name, value, enabled }))
  if (hideSensitive) {
    authentication = redactAuthentication(authentication)
    const secretHeaders = authentication.type === 'customHeader' ? [authentication.name.trim()] : []
    headers = headers.map((header) =>
      isCredentialHeader(header.name.trim(), secretHeaders) ? { ...header, value: withoutLiteralSecret(header.value) } : header,
    )
  }

  const restBody = tab.protocol === 'rest' ? toRestBodyInput(tab.body) : null
  const grpc = tab.protocol === 'grpc' ? tab.grpc ?? emptyGrpcCall : null
  const request: SavedRequestDto = {
    id: 'shared-request',
    name: requestName.trim() || 'Imported Request',
    protocol: tab.protocol,
    endpoint: tab.endpointUrl,
    method: tab.method,
    body: grpc ? grpc.message : restBody ? restBodyText(restBody) : tab.query,
    ...(grpc ? { grpc: { service: grpc.service, method: grpc.method, schemaSource: grpc.schemaSource, deadlineMs: grpc.deadlineMs } } : {}),
    restBody,
    variables: tab.protocol === 'graphql' ? tab.variables : '',
    headers,
    authentication,
    preRequestScript: '',
    postResponseScript: '',
  }

  return {
    id: 'shared-collection',
    name: request.name,
    folders: [],
    requests: [request],
    authentication: { type: 'none' },
    variables: [],
  }
}
