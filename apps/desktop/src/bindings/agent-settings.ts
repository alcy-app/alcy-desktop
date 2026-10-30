import { invokeResult } from './invoke-result'

export type AgentProviderKind = 'anthropic' | 'openaiCompatible'

export interface AgentProviderDto {
  id: string
  kind: AgentProviderKind
  label: string
  baseUrl: string
  model: string
  /** The key itself never leaves the keyring. */
  hasApiKey: boolean
}

export interface AgentSettingsDto {
  providers: AgentProviderDto[]
  /** `null` until the user sets the agent up. */
  activeProviderId: string | null
}

export type AgentProviderInput = Omit<AgentProviderDto, 'hasApiKey'>

export interface AgentModelDto {
  id: string
  label: string
}

export type AgentCommandError =
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string }
  | { kind: 'credentials'; message: string }
  | { kind: 'unknownProvider' }
  | { kind: 'missingApiKey' }
  | { kind: 'missingModel' }
  | { kind: 'busy' }
  | { kind: 'notFound' }
  | { kind: 'unauthorized' }
  | { kind: 'rateLimited' }
  | { kind: 'network'; message: string }
  | { kind: 'provider'; status: number; message: string }
  | { kind: 'invalidResponse'; message: string }

export function getAgentSettings() {
  return invokeResult<AgentSettingsDto, AgentCommandError>('get_agent_settings')
}

export function saveAgentSettings(input: { providers: AgentProviderInput[]; activeProviderId: string | null }) {
  return invokeResult<AgentSettingsDto, AgentCommandError>('save_agent_settings', { input })
}

/** Stores the key in the system keyring. */
export function setAgentApiKey(providerId: string, apiKey: string) {
  return invokeResult<void, AgentCommandError>('set_agent_api_key', { input: { providerId, apiKey } })
}

export function clearAgentApiKey(providerId: string) {
  return invokeResult<void, AgentCommandError>('clear_agent_api_key', { input: { providerId } })
}

/** Also tests the connection and the key. */
export function listAgentModels(providerId: string) {
  return invokeResult<AgentModelDto[], AgentCommandError>('list_agent_models', { input: { providerId } })
}
