import { useCallback, useEffect, useState } from 'react'
import { getAgentSettings, saveAgentSettings, type AgentProviderDto, type AgentSettingsDto } from '../../bindings/agent-settings'

export type AgentSettingsState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; settings: AgentSettingsDto }

/** A provider the chat can use: it has a key, or speaks the OpenAI format (local servers need none). */
export function isProviderUsable(provider: AgentProviderDto): boolean {
  return (provider.hasApiKey || provider.kind === 'openaiCompatible') && provider.model.trim() !== ''
}

function toState(result: Awaited<ReturnType<typeof getAgentSettings>>): AgentSettingsState {
  if (result.ok) return { status: 'ready', settings: result.value }
  return { status: 'error', message: 'message' in result.error ? result.error.message : result.error.kind }
}

/** Agent settings as the chat panel needs them; `reload` after Settings changes them. */
export function useAgentSettings() {
  const [state, setState] = useState<AgentSettingsState>({ status: 'loading' })

  const reload = useCallback(async () => {
    setState(toState(await getAgentSettings()))
  }, [])

  useEffect(() => {
    let cancelled = false
    void getAgentSettings().then((result) => {
      if (!cancelled) setState(toState(result))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setActiveProvider = useCallback(
    async (providerId: string) => {
      if (state.status !== 'ready') return
      const { providers } = state.settings
      const result = await saveAgentSettings({
        providers: providers.map(({ id, kind, label, baseUrl, model }) => ({ id, kind, label, baseUrl, model })),
        activeProviderId: providerId,
      })
      if (result.ok) setState({ status: 'ready', settings: result.value })
    },
    [state],
  )

  return { state, reload, setActiveProvider }
}
