import type { AuthenticationInput } from '../../bindings/execute-graphql-request'
import type { AuthorizationState } from './request-workbench.types'

export function toAuthenticationInput(authorization: AuthorizationState): AuthenticationInput {
  switch (authorization.type) {
    case 'inherit':
      return { type: 'inherit' }
    case 'none':
      return { type: 'none' }
    case 'customHeader':
      return { type: 'customHeader', name: authorization.headerName, value: authorization.headerValue }
    case 'bearer':
      return { type: 'bearer', token: authorization.token }
    case 'basic':
      return { type: 'basic', username: authorization.username, password: authorization.password }
    case 'digest':
      return { type: 'digest', username: authorization.username, password: authorization.password }
    case 'oauth2ClientCredentials':
      return {
        type: 'oauth2ClientCredentials',
        clientId: authorization.clientId,
        clientSecret: authorization.clientSecret,
        tokenUrl: authorization.tokenUrl,
        scope: authorization.scope,
      }
  }
}

export const emptyAuthorizationState: AuthorizationState = {
  type: 'none',
  headerName: '',
  headerValue: '',
  token: '',
  username: '',
  password: '',
  clientId: '',
  clientSecret: '',
  tokenUrl: '',
  scope: '',
}

export function toAuthorizationState(authentication: AuthenticationInput): AuthorizationState {
  switch (authentication.type) {
    case 'inherit':
      return { ...emptyAuthorizationState, type: 'inherit' }
    case 'none':
      return { ...emptyAuthorizationState }
    case 'customHeader':
      return {
        ...emptyAuthorizationState,
        type: 'customHeader',
        headerName: authentication.name,
        headerValue: authentication.value,
      }
    case 'bearer':
      return { ...emptyAuthorizationState, type: 'bearer', token: authentication.token }
    case 'basic':
      return {
        ...emptyAuthorizationState,
        type: 'basic',
        username: authentication.username,
        password: authentication.password,
      }
    case 'digest':
      return {
        ...emptyAuthorizationState,
        type: 'digest',
        username: authentication.username,
        password: authentication.password,
      }
    case 'oauth2ClientCredentials':
      return {
        ...emptyAuthorizationState,
        type: 'oauth2ClientCredentials',
        clientId: authentication.clientId,
        clientSecret: authentication.clientSecret,
        tokenUrl: authentication.tokenUrl,
        scope: authentication.scope,
      }
  }
}

export function sameAuthentication(a: AuthenticationInput, b: AuthenticationInput): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'customHeader' && b.type === 'customHeader') return a.name === b.name && a.value === b.value
  if (a.type === 'bearer' && b.type === 'bearer') return a.token === b.token
  if (a.type === 'basic' && b.type === 'basic') return a.username === b.username && a.password === b.password
  if (a.type === 'digest' && b.type === 'digest') return a.username === b.username && a.password === b.password
  if (a.type === 'oauth2ClientCredentials' && b.type === 'oauth2ClientCredentials') {
    return (
      a.clientId === b.clientId &&
      a.clientSecret === b.clientSecret &&
      a.tokenUrl === b.tokenUrl &&
      a.scope === b.scope
    )
  }
  return true
}

export interface AuthenticationHeader {
  name: string
  value: string
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function authenticationHeader(authentication: AuthenticationInput | undefined): AuthenticationHeader | null {
  if (!authentication) return null
  switch (authentication.type) {
    case 'bearer':
      return { name: 'Authorization', value: `Bearer ${authentication.token}` }
    case 'basic': {
      const credentials = `${authentication.username}:${authentication.password}`
      const encoded = credentials.includes('{{') ? credentials : base64Utf8(credentials)
      return { name: 'Authorization', value: `Basic ${encoded}` }
    }
    case 'oauth2ClientCredentials':
      return { name: 'Authorization', value: 'Bearer <access_token>' }
    case 'customHeader': {
      const name = authentication.name.trim()
      return name.length > 0 ? { name, value: authentication.value } : null
    }
    case 'digest':
    case 'inherit':
    case 'none':
      return null
  }
}

export function overwrittenHeaderName(authentication: AuthenticationInput | undefined): string | null {
  if (authentication?.type === 'digest') return 'Authorization'
  return authenticationHeader(authentication)?.name ?? null
}
