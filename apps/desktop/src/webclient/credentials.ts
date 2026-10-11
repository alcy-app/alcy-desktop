/**
 * Credenciais preenchidas na tela, aplicadas sobre a requisição antes da
 * interpolação. Os alvos vêm do export (`crates/alcy-webclient/src/redaction.rs`).
 */

import type { Authentication, Credential, CredentialValues, WebclientRequest } from './types'

/** Valor preenchido para a credencial, ou `undefined` se vazio. */
export function filledValue(values: CredentialValues, id: string): string | undefined {
  const value = values[id]
  return value === undefined || value === '' ? undefined : value
}

/** Variáveis preenchidas, que sobrepõem ambiente e pastas. */
export function credentialVariables(credentials: Credential[], values: CredentialValues): Map<string, string> {
  const variables = new Map<string, string>()
  for (const credential of credentials) {
    const value = filledValue(values, credential.id)
    if (credential.target.kind === 'variable' && value !== undefined) variables.set(credential.target.name, value)
  }
  return variables
}

/** Aplica as credenciais de autenticação do nó dono da autenticação efetiva. */
export function applyAuthenticationCredentials(
  authentication: Authentication,
  ownerId: string | null,
  credentials: Credential[],
  values: CredentialValues,
): Authentication {
  let result = authentication
  for (const credential of credentials) {
    const { target } = credential
    const value = filledValue(values, credential.id)
    if (target.kind !== 'authentication' || target.nodeId !== ownerId || value === undefined) continue
    if (target.field === 'token' && result.type === 'bearer') result = { ...result, token: value }
    if (target.field === 'password' && (result.type === 'basic' || result.type === 'digest')) result = { ...result, password: value }
    if (target.field === 'value' && result.type === 'customHeader') result = { ...result, value }
    if (target.field === 'clientSecret' && result.type === 'oauth2ClientCredentials') result = { ...result, clientSecret: value }
  }
  return result
}

/** Mesmo padrão de `KEYED_STRING` em `redaction.rs`. */
const keyedStringPattern = () => /("?)([A-Za-z_][\w-]*)("?)(\s*:\s*)"((?:\\.|[^"\\])*)"/g

/** Troca o valor de `"chave": "…"`/`chave: "…"` pelo valor dado, escapado. */
export function replaceKeyedString(text: string, key: string, value: string): string {
  const escaped = JSON.stringify(value).slice(1, -1)
  return text.replace(keyedStringPattern(), (whole, open: string, name: string, close: string, separator: string) =>
    open === close && name === key ? `${open}${name}${close}${separator}"${escaped}"` : whole,
  )
}

/** Troca o valor de `nome=` na query string. O valor entra como digitado,
 * igual à URL editada no app (pode conter `{{variável}}`). */
export function replaceQueryValue(url: string, name: string, value: string): string {
  const queryStart = url.indexOf('?')
  if (queryStart < 0) return url
  const hash = url.indexOf('#', queryStart)
  const queryEnd = hash < 0 ? url.length : hash
  const pairs = url
    .slice(queryStart + 1, queryEnd)
    .split('&')
    .map((pair) => (pair.includes('=') && pair.split('=')[0] === name ? `${name}=${value}` : pair))
  return `${url.slice(0, queryStart)}?${pairs.join('&')}${url.slice(queryEnd)}`
}

/** Aplica sobre uma cópia da requisição as credenciais que apontam para ela. */
export function applyRequestCredentials(
  request: WebclientRequest,
  credentials: Credential[],
  values: CredentialValues,
): WebclientRequest {
  let result: WebclientRequest = { ...request }
  for (const credential of credentials) {
    const { target } = credential
    const value = filledValue(values, credential.id)
    if (value === undefined || target.kind === 'variable' || target.kind === 'authentication') continue
    if (target.nodeId !== request.id) continue
    switch (target.kind) {
      case 'header':
        result = {
          ...result,
          headers: result.headers.map((header) =>
            header.name.trim().toLowerCase() === target.name.toLowerCase() ? { ...header, value } : header,
          ),
        }
        break
      case 'query':
        result = { ...result, url: replaceQueryValue(result.url, target.name, value) }
        break
      case 'routeParameter':
        result = {
          ...result,
          routeParameters: result.routeParameters.map((parameter) =>
            parameter.name === target.name ? { ...parameter, value } : parameter,
          ),
        }
        break
      case 'bodyField':
        if (result.bodyPayload.type === 'urlEncoded' || result.bodyPayload.type === 'formData') {
          result = {
            ...result,
            bodyPayload: {
              ...result.bodyPayload,
              fields: result.bodyPayload.fields.map((field) => (field.name === target.name ? { ...field, value } : field)),
            },
          }
        }
        break
      case 'bodyText':
        if (target.source === 'variables') {
          result = { ...result, variables: replaceKeyedString(result.variables, target.key, value) }
        } else {
          result = { ...result, body: replaceKeyedString(result.body, target.key, value) }
        }
        break
    }
  }
  return result
}

const storageKey = (exportId: string) => `alcy-webclient:${exportId}:credentials`

/** Valores lembrados neste navegador, ou `null` se não houver. */
export function loadRememberedValues(exportId: string): CredentialValues | null {
  try {
    const stored = window.localStorage.getItem(storageKey(exportId))
    if (!stored) return null
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return null
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return null
  }
}

/** Grava (`values`) ou esquece (`null`) os valores deste export. */
export function storeRememberedValues(exportId: string, values: CredentialValues | null): void {
  try {
    if (values === null) window.localStorage.removeItem(storageKey(exportId))
    else window.localStorage.setItem(storageKey(exportId), JSON.stringify(values))
  } catch {
    // Armazenamento bloqueado (janela privada, política do navegador): os
    // valores continuam valendo nesta aba.
  }
}
