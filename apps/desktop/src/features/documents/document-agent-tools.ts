import type { AgentContextInput } from '../../bindings/agent-turn'
import type { WorkbenchAgentHost } from '../agent/agent-host'
import type { AgentToolOutcome } from '../agent/agent-tools'

export const DOCUMENT_TOOL_NAMES = ['get_documentation_guide', 'list_documents', 'get_document', 'get_document_outline', 'create_document', 'update_document', 'delete_document', 'open_document', 'read_document_source', 'add_document_image', 'export_document'] as const
export function isDocumentTool(name: string): boolean { return (DOCUMENT_TOOL_NAMES as readonly string[]).includes(name) }
export interface AgentDocumentHost {
  cancel(): void
  call(name: string, input: Record<string, unknown>, host: WorkbenchAgentHost): Promise<AgentToolOutcome>
  context(): AgentContextInput[]
  open(id: string): Promise<boolean>
}
