/**
 * Contrato do payload embutido no webclient. Espelha a serialização de
 * `crates/alcy-webclient` (`snapshot.rs`, `redaction.rs`, `seal.rs`); a
 * versão fica em `SNAPSHOT_VERSION`.
 */

export const SNAPSHOT_VERSION = 1

export type TransportMode = 'auto' | 'direct' | 'server'

export interface Variable {
  name: string
  value: string
}

export interface Field {
  name: string
  value: string
  enabled: boolean
}

export type Authentication =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'customHeader'; name: string; value: string }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'digest'; username: string; password: string }
  | { type: 'oauth2ClientCredentials'; clientId: string; clientSecret: string; tokenUrl: string; scope: string }

export type BodyPayload =
  | { type: 'none' }
  | { type: 'raw'; language: 'text' | 'javascript' | 'json' | 'html' | 'xml' }
  | { type: 'urlEncoded'; fields: Field[] }
  | { type: 'formData'; fields: Field[] }
  | { type: 'binary' }

export type UnsupportedFeature = 'binaryBody' | 'formDataFile' | 'digestAuthentication' | 'grpc'

export interface WebclientRequest {
  id: string
  name: string
  protocol: 'graphql' | 'rest'
  method: string
  url: string
  headers: Field[]
  authentication: Authentication
  /** Query GraphQL, ou o texto do corpo REST. */
  body: string
  bodyPayload: BodyPayload
  /** Variáveis GraphQL (JSON em texto). */
  variables: string
  routeParameters: Variable[]
  unsupported: UnsupportedFeature[]
}

export interface WebclientFolder {
  id: string
  name: string
  variables: Variable[]
  authentication: Authentication
  folders: WebclientFolder[]
  requests: WebclientRequest[]
}

export type AuthenticationField = 'token' | 'password' | 'value' | 'clientSecret'
export type TextSource = 'body' | 'variables' | 'query'

export type CredentialTarget =
  | { kind: 'variable'; name: string }
  | { kind: 'authentication'; nodeId: string; field: AuthenticationField }
  | { kind: 'header'; nodeId: string; name: string }
  | { kind: 'query'; nodeId: string; name: string }
  | { kind: 'routeParameter'; nodeId: string; name: string }
  | { kind: 'bodyField'; nodeId: string; name: string }
  | { kind: 'bodyText'; nodeId: string; source: TextSource; key: string }

export interface Credential {
  id: string
  owner: string | null
  target: CredentialTarget
  /** O valor original veio no export. */
  included: boolean
}

export interface Snapshot {
  version: number
  exportId: string
  title: string
  transport: TransportMode
  environment: { name: string; variables: Variable[] } | null
  credentials: Credential[]
  root: WebclientFolder
}

export interface SealedEnvelope {
  version: number
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string
  nonce: string
  ciphertext: string
}

export type Payload = { format: 'plain'; snapshot: Snapshot } | { format: 'sealed'; envelope: SealedEnvelope }

/** Valores preenchidos pelo usuário, por id de credencial. */
export type CredentialValues = Record<string, string>
