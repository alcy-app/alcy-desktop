/**
 * Monta a chamada HTTP de uma requisição do webclient: aplica credenciais,
 * resolve variáveis e traduz autenticação e corpo, como o backend faz no
 * app (`alcy-rest`, `alcy-graphql`, `alcy-http-auth`).
 */

import { applyAuthenticationCredentials, applyRequestCredentials, credentialVariables } from './credentials'
import { applyRouteParameters, mergeVariables, resolveTemplate } from './interpolate'
import type { Authentication, CredentialValues, Snapshot, UnsupportedFeature, WebclientFolder, WebclientRequest } from './types'

export type CallBody = { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'multipart'; fields: [string, string][] }

export interface HttpCall {
  method: string
  url: string
  headers: [string, string][]
  body: CallBody
}

/** Token buscado antes da chamada (OAuth2 client credentials). */
export interface OAuth2Step {
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope: string
}

export type PrepareError =
  | { kind: 'missingVariables'; names: string[] }
  | { kind: 'invalidVariables'; message: string }
  | { kind: 'unsupported'; features: UnsupportedFeature[] }

export type Prepared = { ok: true; call: HttpCall; oauth2: OAuth2Step | null } | { ok: false; error: PrepareError }

/** Autenticação efetiva (própria ou da pasta mais próxima) e o nó dono dela. */
export function effectiveAuthentication(
  request: WebclientRequest,
  chain: WebclientFolder[],
): { authentication: Authentication; ownerId: string | null } {
  if (request.authentication.type !== 'inherit') return { authentication: request.authentication, ownerId: request.id }
  for (let index = chain.length - 1; index >= 0; index--) {
    const folder = chain[index]
    if (folder.authentication.type !== 'inherit') return { authentication: folder.authentication, ownerId: folder.id }
  }
  return { authentication: { type: 'none' }, ownerId: null }
}

function utf8Base64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * `chain` vai da raiz do export até a pasta que contém a requisição.
 * `request` é o rascunho da sessão (edições na tela), não o original.
 */
export function prepareRequest(
  request: WebclientRequest,
  chain: WebclientFolder[],
  snapshot: Snapshot,
  values: CredentialValues,
): Prepared {
  if (request.unsupported.length > 0) return { ok: false, error: { kind: 'unsupported', features: request.unsupported } }

  const effective = effectiveAuthentication(request, chain)
  const authentication = applyAuthenticationCredentials(effective.authentication, effective.ownerId, snapshot.credentials, values)
  const draft = applyRequestCredentials(request, snapshot.credentials, values)

  const variables = mergeVariables(
    snapshot.environment?.variables ?? [],
    chain.map((folder) => folder.variables),
  )
  for (const [name, value] of credentialVariables(snapshot.credentials, values)) variables.set(name, value)

  const missing = new Set<string>()
  const resolve = (template: string) => {
    const resolution = resolveTemplate(template, variables)
    resolution.missing.forEach((name) => missing.add(name))
    return resolution.text
  }

  const routeParameters = draft.routeParameters.map((parameter) => ({ ...parameter, value: resolve(parameter.value) }))
  const url = applyRouteParameters(resolve(draft.url), routeParameters)
  let headers: [string, string][] = draft.headers
    .filter((header) => header.enabled && header.name.trim() !== '')
    .map((header) => [header.name.trim(), resolve(header.value)])

  let oauth2: OAuth2Step | null = null
  switch (authentication.type) {
    case 'bearer':
      headers = headers.filter(([name]) => !sameName(name, 'authorization'))
      headers.push(['Authorization', `Bearer ${resolve(authentication.token)}`])
      break
    case 'basic':
      headers = headers.filter(([name]) => !sameName(name, 'authorization'))
      headers.push(['Authorization', `Basic ${utf8Base64(`${resolve(authentication.username)}:${resolve(authentication.password)}`)}`])
      break
    case 'customHeader': {
      const name = resolve(authentication.name).trim()
      if (name) {
        headers = headers.filter(([existing]) => !sameName(existing, name))
        headers.push([name, resolve(authentication.value)])
      }
      break
    }
    case 'oauth2ClientCredentials':
      oauth2 = {
        tokenUrl: resolve(authentication.tokenUrl),
        clientId: resolve(authentication.clientId),
        clientSecret: resolve(authentication.clientSecret),
        scope: resolve(authentication.scope),
      }
      break
    case 'digest':
      return { ok: false, error: { kind: 'unsupported', features: ['digestAuthentication'] } }
    case 'none':
    case 'inherit':
      break
  }

  let body: CallBody = { kind: 'none' }
  if (draft.protocol === 'graphql') {
    const variablesText = resolve(draft.variables)
    let parsedVariables: unknown = null
    if (variablesText.trim() !== '') {
      try {
        parsedVariables = JSON.parse(variablesText)
      } catch (error) {
        return { ok: false, error: { kind: 'invalidVariables', message: error instanceof Error ? error.message : String(error) } }
      }
    }
    // A query GraphQL não é interpolada, igual ao app.
    body = { kind: 'text', text: JSON.stringify({ query: draft.body, variables: parsedVariables }) }
    if (!headers.some(([name]) => sameName(name, 'content-type'))) headers.push(['Content-Type', 'application/json'])
  } else {
    const payload = draft.bodyPayload
    if (payload.type === 'urlEncoded') {
      const encoded = new URLSearchParams(
        payload.fields.filter((field) => field.enabled).map((field) => [resolve(field.name), resolve(field.value)]),
      ).toString()
      if (encoded) {
        body = { kind: 'text', text: encoded }
        if (!headers.some(([name]) => sameName(name, 'content-type'))) {
          headers.push(['Content-Type', 'application/x-www-form-urlencoded'])
        }
      }
    } else if (payload.type === 'formData') {
      headers = headers.filter(([name]) => !sameName(name, 'content-type'))
      body = {
        kind: 'multipart',
        fields: payload.fields.filter((field) => field.enabled).map((field) => [resolve(field.name), resolve(field.value)]),
      }
    } else {
      const text = resolve(draft.body)
      if (text !== '') body = { kind: 'text', text }
    }
  }

  if (missing.size > 0) return { ok: false, error: { kind: 'missingVariables', names: [...missing] } }
  return { ok: true, call: { method: draft.method, url, headers, body }, oauth2 }
}
