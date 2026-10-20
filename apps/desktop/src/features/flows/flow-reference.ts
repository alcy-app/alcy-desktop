import { createContext, useContext } from 'react'

export const FLOW_REFERENCE_MIME = 'application/x-alcy-flow-reference'

interface MappingContext {
  insert: (reference: string) => boolean
  hasTarget: boolean
  registerReferences: (references: string[]) => void
  references: string[]
}

export const FlowMappingContext = createContext<MappingContext>({ insert: () => false, hasTarget: false, registerReferences: () => undefined, references: [] })
export const useFlowMapping = () => useContext(FlowMappingContext)

/** JSON pointers are for inspection; execution continues using the existing dot syntax. */
export function referenceFromPointer(nodeId: string, pointer: string, scope: 'response' | 'request' = 'response'): string | null {
  if (pointer && !pointer.startsWith('/')) return null
  const parts = pointer ? pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')) : []
  if (parts.some((part) => !part || /[.{}]/.test(part))) return null
  return `{{nodes.${nodeId}.${scope}.body${parts.length ? `.${parts.join('.')}` : ''}}}`
}
