import type { TranslationKey } from '../../shared/i18n/translations'
import type { useLanguage } from '../../shared/i18n/use-language'
import { RESOURCE_TOOL_NAMES } from './agent-resource-tools'
import { DOCUMENT_TOOL_NAMES } from '../documents/document-agent-tools'

const KNOWN_TOOLS = new Set([
  ...DOCUMENT_TOOL_NAMES,
  ...RESOURCE_TOOL_NAMES,
  'list_open_tabs',
  'get_request',
  'get_response',
  'search_collections',
  'list_environments',
  'open_request',
  'select_tab',
  'new_request_tab',
  'update_request',
  'send_request',
  'cancel_request',
  'send_grpc_message',
  'close_grpc_send',
  'send_websocket_message',
  'close_websocket',
  'save_request',
  'import_from_text',
  'create_collection',
  'create_folder',
  'set_environment_variable',
  'set_active_environment',
  'close_tab',
  'highlight_in_editor',
])

/** What a tool call does, in the interface language; unknown tools show their name. */
export function toolLabel(name: string, t: ReturnType<typeof useLanguage>['t']): string {
  return KNOWN_TOOLS.has(name) ? t(`agent.tool.${name}` as TranslationKey) : name
}
