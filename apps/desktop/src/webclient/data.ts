import { SNAPSHOT_VERSION, type Payload, type SealedEnvelope, type Snapshot, type WebclientFolder, type WebclientRequest } from './types'

export const DATA_ELEMENT_ID = 'alcy-webclient-data'

export type LoadedPayload =
  | { kind: 'ready'; snapshot: Snapshot }
  | { kind: 'sealed'; envelope: SealedEnvelope }
  | { kind: 'invalid' }
  | { kind: 'newerVersion' }

/** Confere a versão e a forma mínima de um snapshot já decodificado. */
export function toSnapshot(value: unknown): LoadedPayload {
  if (!value || typeof value !== 'object') return { kind: 'invalid' }
  const snapshot = value as Partial<Snapshot>
  if (typeof snapshot.version !== 'number') return { kind: 'invalid' }
  if (snapshot.version > SNAPSHOT_VERSION) return { kind: 'newerVersion' }
  if (!snapshot.root || !Array.isArray(snapshot.credentials) || typeof snapshot.exportId !== 'string') {
    return { kind: 'invalid' }
  }
  return { kind: 'ready', snapshot: snapshot as Snapshot }
}

/** Lê o payload que o app injetou no `<script type="application/json">`. */
export function readPayload(text: string | null | undefined): LoadedPayload {
  if (!text) return { kind: 'invalid' }
  let payload: Payload
  try {
    payload = JSON.parse(text) as Payload
  } catch {
    return { kind: 'invalid' }
  }
  if (payload?.format === 'plain') return toSnapshot(payload.snapshot)
  if (payload?.format === 'sealed' && payload.envelope) return { kind: 'sealed', envelope: payload.envelope }
  return { kind: 'invalid' }
}

export interface RequestEntry {
  request: WebclientRequest
  /** Pastas da raiz até a que contém a requisição. */
  chain: WebclientFolder[]
}

/** Índice das requisições da árvore, na ordem de exibição. */
export function indexRequests(root: WebclientFolder): Map<string, RequestEntry> {
  const entries = new Map<string, RequestEntry>()
  const walk = (folder: WebclientFolder, chain: WebclientFolder[]) => {
    const current = [...chain, folder]
    for (const request of folder.requests) entries.set(request.id, { request, chain: current })
    for (const child of folder.folders) walk(child, current)
  }
  walk(root, [])
  return entries
}
