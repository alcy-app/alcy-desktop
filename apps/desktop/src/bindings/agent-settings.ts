import { invokeResult } from './invoke-result'

export type AgentProviderKind = 'anthropic' | 'openaiCompatible'

export interface AgentProviderDto {
  id: string
  kind: AgentProviderKind
  label: string
  baseUrl: string
  model: string
  /** Tokens per local day / week the user wants to stay under; `null` is no limit. Only warns. */
  dailyTokenLimit: number | null
  weeklyTokenLimit: number | null
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

export interface AgentTokenTotalsDto {
  input: number
  output: number
}

export interface AgentUsageDto {
  today: AgentTokenTotalsDto
  week: AgentTokenTotalsDto
}

/** Tokens the provider used today and this week, counted on this machine. Days are local `YYYY-MM-DD`. */
export function getAgentUsage(providerId: string, today: string, week: string[]) {
  return invokeResult<AgentUsageDto, AgentCommandError>('get_agent_usage', { input: { providerId, today, week } })
}

/** Also tests the connection and the key. */
export function listAgentModels(providerId: string) {
  return invokeResult<AgentModelDto[], AgentCommandError>('list_agent_models', { input: { providerId } })
}
