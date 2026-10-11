import type { AuthenticationInput, Cookie, ResponseHeader } from '../../bindings/execute-graphql-request'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { SENSITIVE_MASK } from '../environments/environments.types'
import { resolveTemplateRevealingSecrets } from './resolve-url'
import type { ConsoleEntry, ConsoleEntryDetail } from './use-console-state'

export interface SensitiveValue {
  name: string
  value: string
}

/** O que a ocultação precisa saber sobre o envio, capturado no momento em
 * que a chamada foi gravada. */
export interface HarRedactionContext {
  /** Variáveis sensíveis em vigor no envio (incluindo as alteradas pelo pré-script). */
  sensitiveValues: SensitiveValue[]
  /** Headers que carregam credencial além dos conhecidos (ex.: o da auth customizada). */
  secretHeaderNames: string[]
}

/** Entrada do gravador HAR: os dados reais ficam só em memória; a
 * visualização e o `.har` passam por `redactRecordedEntry` enquanto a
 * preferência de segurança estiver ligada. */
export interface RecordedEntry extends ConsoleEntry {
  redaction: HarRedactionContext
}

export type RecordedEntryInput = Omit<RecordedEntry, 'id'>

/** Monta o contexto de ocultação de um envio: as variáveis sensíveis do
 * ambiente ativo, mais os valores que o script gravou nelas, e o header da
 * autenticação customizada efetiva (própria ou herdada). */
export function harRedactionContext(
  variables: EnvironmentVariableDto[],
  environmentChanges: SensitiveValue[],
  authentication: AuthenticationInput | undefined,
): HarRedactionContext {
  const sensitive = variables.filter((variable) => variable.sensitive)
  const sensitiveNames = new Set(sensitive.map((variable) => variable.name))
  return {
    sensitiveValues: [
      ...sensitive.map(({ name, value }) => ({ name, value })),
      ...environmentChanges.filter((change) => sensitiveNames.has(change.name)),
    ],
    secretHeaderNames:
      authentication?.type === 'customHeader' ? [resolveTemplateRevealingSecrets(authentication.name, variables).trim()] : [],
  }
}

const AUTHORIZATION_HEADERS = new Set(['authorization', 'proxy-authorization'])
const SECRET_HEADER_PATTERN = /token|api[-_ ]?key|secret|password|session|credential/i

/** Troca cada valor sensível por `{{nome}}`, a mesma convenção da exibição
 * de variáveis. Os valores já chegam do maior para o menor, para que um
 * segredo que contém outro seja trocado inteiro. */
function replaceSensitiveValues(text: string, values: SensitiveValue[]): string {
  let result = text
  for (const { name, value } of values) {
    result = result.split(value).join(`{{${name}}}`)
  }
  return result
}

/** `Bearer abc` → `Bearer ••••••••`: o esquema ajuda a entender a chamada e não é segredo. */
function maskAuthorization(value: string): string {
  const scheme = value.match(/^(\S+)\s+\S/)
  return scheme ? `${scheme[1]} ${SENSITIVE_MASK}` : SENSITIVE_MASK
}

/** `a=1; b=2` → `a=••••••••; b=••••••••`. */
function maskCookiePairs(value: string): string {
  return value
    .split(';')
    .map((pair) => {
      const separator = pair.indexOf('=')
      return separator < 0 ? pair : `${pair.slice(0, separator + 1)}${SENSITIVE_MASK}`
    })
    .join(';')
}

/** `sid=abc; Path=/; HttpOnly` → `sid=••••••••; Path=/; HttpOnly`: só o valor é segredo. */
function maskSetCookie(value: string): string {
  const attributes = value.indexOf(';')
  const pair = attributes < 0 ? value : value.slice(0, attributes)
  const rest = attributes < 0 ? '' : value.slice(attributes)
  return `${maskCookiePairs(pair)}${rest}`
}

function isSecretHeader(name: string, secretHeaderNames: Set<string>): boolean {
  return secretHeaderNames.has(name.toLowerCase()) || SECRET_HEADER_PATTERN.test(name)
}

/** Header de requisição que carrega credencial (autorização, cookie ou nome
 * de segredo) — a mesma regra da ocultação, para quem precisa só decidir. */
export function isCredentialHeader(name: string, secretHeaderNames: string[] = []): boolean {
  const lower = name.toLowerCase()
  return (
    AUTHORIZATION_HEADERS.has(lower) ||
    lower === 'cookie' ||
    isSecretHeader(name, new Set(secretHeaderNames.map((secret) => secret.toLowerCase())))
  )
}

function redactRequestHeader(header: ResponseHeader, secretHeaderNames: Set<string>, values: SensitiveValue[]): ResponseHeader {
  if (header.value === '') return header
  const name = header.name.toLowerCase()
  if (AUTHORIZATION_HEADERS.has(name)) return { ...header, value: maskAuthorization(header.value) }
  if (name === 'cookie') return { ...header, value: maskCookiePairs(header.value) }
  if (isSecretHeader(header.name, secretHeaderNames)) return { ...header, value: SENSITIVE_MASK }
  return { ...header, value: replaceSensitiveValues(header.value, values) }
}

function redactResponseHeader(header: ResponseHeader, secretHeaderNames: Set<string>): ResponseHeader {
  if (header.value === '') return header
  if (header.name.toLowerCase() === 'set-cookie') return { ...header, value: maskSetCookie(header.value) }
  if (isSecretHeader(header.name, secretHeaderNames)) return { ...header, value: SENSITIVE_MASK }
  return header
}

function redactCookie(cookie: Cookie): Cookie {
  return cookie.value === '' ? cookie : { ...cookie, value: SENSITIVE_MASK }
}

function redactDetail(detail: ConsoleEntryDetail, secretHeaderNames: Set<string>, values: SensitiveValue[]): ConsoleEntryDetail {
  return {
    ...detail,
    requestBody: replaceSensitiveValues(detail.requestBody, values),
    requestHeaders: detail.requestHeaders.map((header) => redactRequestHeader(header, secretHeaderNames, values)),
    finalUrl: detail.finalUrl === null ? null : replaceSensitiveValues(detail.finalUrl, values),
    cookies: detail.cookies.map(redactCookie),
    responseHeaders: detail.responseHeaders.map((header) => redactResponseHeader(header, secretHeaderNames)),
  }
}

function prepareRedaction(context: HarRedactionContext): { values: SensitiveValue[]; secretHeaderNames: Set<string> } {
  return {
    values: context.sensitiveValues
      .filter(({ value }) => value !== '')
      .sort((a, b) => b.value.length - a.value.length),
    secretHeaderNames: new Set(context.secretHeaderNames.map((name) => name.toLowerCase())),
  }
}

/** Headers sem credenciais, com as mesmas regras do HAR — para exibições
 * fora do gravador, como a imagem de compartilhamento (`screenshot/`). */
export function redactHeaders(
  headers: ResponseHeader[],
  direction: 'request' | 'response',
  context: HarRedactionContext,
): ResponseHeader[] {
  const { values, secretHeaderNames } = prepareRedaction(context)
  return headers.map((header) =>
    direction === 'request'
      ? redactRequestHeader(header, secretHeaderNames, values)
      : redactResponseHeader(header, secretHeaderNames),
  )
}

/** Versão da entrada gravada sem credenciais: headers de autorização e
 * cookies mascarados, valores de variáveis sensíveis trocados por `{{nome}}`
 * na URL, nos headers e no corpo da requisição. O corpo da resposta não é
 * alterado. */
export function redactRecordedEntry(entry: RecordedEntry): RecordedEntry {
  const { values, secretHeaderNames } = prepareRedaction(entry.redaction)
  return {
    ...entry,
    endpointUrl: replaceSensitiveValues(entry.endpointUrl, values),
    detail: entry.detail && redactDetail(entry.detail, secretHeaderNames, values),
  }
}
