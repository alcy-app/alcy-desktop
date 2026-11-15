import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import type { AgentProviderDto, AgentSettingsDto } from '../../bindings/agent-settings'
import { AgentSection } from './AgentSection'
import { SettingsPage } from './SettingsPage'
import { MentionInChatMenuItem } from '../agent/MentionInChatMenuItem'

const getAgentSettings = vi.fn()
const saveAgentSettings = vi.fn()
const setAgentApiKey = vi.fn()
const clearAgentApiKey = vi.fn()
const listAgentModels = vi.fn()

vi.mock('../../bindings/agent-settings', () => ({
  getAgentSettings: () => getAgentSettings(),
  saveAgentSettings: (...args: unknown[]) => saveAgentSettings(...args),
  setAgentApiKey: (...args: unknown[]) => setAgentApiKey(...args),
  clearAgentApiKey: (...args: unknown[]) => clearAgentApiKey(...args),
  listAgentModels: (...args: unknown[]) => listAgentModels(...args),
}))

const claude: AgentProviderDto = { id: 'claude', kind: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', hasApiKey: false }
const local: AgentProviderDto = { id: 'custom', kind: 'openaiCompatible', label: 'Custom', baseUrl: 'http://localhost:11434/v1', model: '', hasApiKey: false }

let current: AgentSettingsDto

beforeEach(() => {
  current = { providers: [claude, local], activeProviderId: null }
  getAgentSettings.mockReset().mockImplementation(async () => ({ ok: true, value: current }))
  saveAgentSettings.mockReset().mockImplementation(async (input: { providers: Omit<AgentProviderDto, 'hasApiKey'>[]; activeProviderId: string | null }) => {
    current = {
      providers: input.providers.map((provider) => ({ ...provider, hasApiKey: current.providers.find((old) => old.id === provider.id)?.hasApiKey ?? false })),
      activeProviderId: input.activeProviderId,
    }
    return { ok: true, value: current }
  })
  setAgentApiKey.mockReset().mockImplementation(async (id: string) => {
    current = { ...current, providers: current.providers.map((provider) => (provider.id === id ? { ...provider, hasApiKey: true } : provider)) }
    return { ok: true, value: undefined }
  })
  clearAgentApiKey.mockReset().mockResolvedValue({ ok: true, value: undefined })
  listAgentModels.mockReset().mockResolvedValue({ ok: true, value: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
})

const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('li') as HTMLElement

describe('AgentSection', () => {
  it('applies edits to multiple providers together, including a collapsed card', async () => {
    render(<SettingsPage page="agent" active id="agent-test"><AgentSection /></SettingsPage>)
    const claudeCard = await waitFor(() => card('Claude'))
    fireEvent.change(within(claudeCard).getByDisplayValue('claude-sonnet-5-5'), { target: { value: 'claude-opus-5-5' } })
    fireEvent.click(screen.getByRole('button', { name: /^Custom/ }))
    fireEvent.change(within(card('Custom')).getByRole('combobox', { name: 'Modelo' }), { target: { value: 'local-model' } })
    expect(saveAgentSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))

    await waitFor(() => expect(screen.getByText('Alterações aplicadas')).toBeVisible())
    expect(current.providers.map((provider) => provider.model)).toEqual(['claude-opus-5-5', 'local-model'])
  })

  it('applies and remembers chat preferences while preserving provider configuration', async () => {
    const content = <>
      <SettingsPage page="agent" active id="agent-test"><AgentSection /></SettingsPage>
      <MentionInChatMenuItem item={{ kind: 'tab', id: 't1', label: 'Users' }} onDone={() => {}} />
    </>
    const { unmount } = render(content)
    await screen.findByRole('button', { name: 'Adicionar provedor' })
    const chat = screen.getByRole('checkbox', { name: 'Habilitar chat' })
    const contexts = screen.getByRole('checkbox', { name: 'Desabilitar opções nos subcontextos' })
    expect(chat).toBeChecked()
    expect(contexts).not.toBeChecked()
    expect(screen.getByRole('menuitem', { name: 'Mencionar no chat' })).toBeInTheDocument()

    fireEvent.click(contexts)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    expect(screen.queryByRole('menuitem', { name: 'Mencionar no chat' })).not.toBeInTheDocument()
    expect(chat).toBeChecked()
    fireEvent.click(contexts)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    expect(screen.getByRole('menuitem', { name: 'Mencionar no chat' })).toBeInTheDocument()

    fireEvent.click(chat)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    expect(screen.queryByRole('menuitem', { name: 'Mencionar no chat' })).not.toBeInTheDocument()
    fireEvent.click(contexts)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    unmount()
    render(content)
    expect(screen.getByRole('checkbox', { name: 'Habilitar chat' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Desabilitar opções nos subcontextos' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Habilitar chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    expect(screen.queryByRole('menuitem', { name: 'Mencionar no chat' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Desabilitar opções nos subcontextos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled())
    expect(screen.getByRole('menuitem', { name: 'Mencionar no chat' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^Claude/ })).toBeInTheDocument()
    expect(saveAgentSettings).not.toHaveBeenCalled()
  })

  it('starts with no provider and adds one from a preset', async () => {
    current = { providers: [], activeProviderId: null }
    render(<SettingsPage page="agent" active id="agent-test"><AgentSection /></SettingsPage>)
    expect(await screen.findByText('Nenhum provedor configurado. Adicione um para usar o agente.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Provedores configurados' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar provedor' }))
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    await waitFor(() => expect(card('Claude')).toBeInTheDocument())
    expect(saveAgentSettings.mock.calls[0][0].providers).toEqual([
      expect.objectContaining({ id: 'claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }),
    ])
    expect(within(card('Claude')).getByText('Falta a chave')).toBeInTheDocument()
    expect(within(card('Claude')).getByRole('button', { name: 'Remover provedor' })).toBeInTheDocument()
  })

  it('summarizes what each provider still needs and opens the first one to set up', async () => {
    render(<SettingsPage page="agent" active id="agent-test"><AgentSection /></SettingsPage>)
    expect(await screen.findByText('Falta a chave')).toBeInTheDocument()
    expect(within(card('Claude')).getByText('Falta a chave')).toBeInTheDocument()
    expect(within(card('Custom')).getByText('Falta o modelo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Claude/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('stores a key, tests the connection and puts the provider in use', async () => {
    render(<SettingsPage page="agent" active id="agent-test"><AgentSection /></SettingsPage>)
    const claudeCard = await waitFor(() => card('Claude'))
    fireEvent.change(within(claudeCard).getByLabelText('Chave de API'), { target: { value: 'sk-test' } })
    fireEvent.click(within(claudeCard).getByRole('button', { name: 'Salvar chave' }))
    expect(await within(claudeCard).findByText('Guardada no chaveiro do sistema')).toBeInTheDocument()
    expect(setAgentApiKey).toHaveBeenCalledWith('claude', 'sk-test')
    expect(within(claudeCard).getByText('Pronto')).toBeInTheDocument()

    fireEvent.click(within(claudeCard).getByRole('button', { name: 'Testar conexão' }))
    expect(await within(claudeCard).findByText('Conectado · 2 modelos disponíveis')).toBeInTheDocument()

    fireEvent.click(within(claudeCard).getByRole('button', { name: 'Usar no chat' }))
    expect(await within(claudeCard).findByText('Em uso')).toBeInTheDocument()
    expect(saveAgentSettings).toHaveBeenLastCalledWith(expect.objectContaining({ activeProviderId: 'claude' }))
  })

  it('asks to save before testing edited fields', async () => {
    render(<SettingsPage page="agent" active id="agent-test"><AgentSection /></SettingsPage>)
    const claudeCard = await waitFor(() => card('Claude'))
    fireEvent.change(within(claudeCard).getByDisplayValue('claude-sonnet-5-5'), { target: { value: 'claude-opus-5-5' } })
    expect(within(claudeCard).getByRole('button', { name: 'Testar conexão' })).toBeDisabled()
    expect(within(claudeCard).getByText('Salve as alterações para testar.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(saveAgentSettings).toHaveBeenCalled())
    expect(saveAgentSettings.mock.calls[0][0].providers[0].model).toBe('claude-opus-5-5')
  })

  it('adds a provider from a preset and removes it with its key', async () => {
    render(<SettingsPage page="agent" active id="agent-test"><AgentSection /></SettingsPage>)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar provedor' }))
    fireEvent.click(screen.getByRole('button', { name: /OpenRouter/ }))
    await waitFor(() => expect(card('OpenRouter')).toBeInTheDocument())
    expect(saveAgentSettings.mock.calls[0][0].providers.at(-1)).toEqual(
      expect.objectContaining({ id: 'openrouter', kind: 'openaiCompatible', baseUrl: 'https://openrouter.ai/api/v1' }),
    )
    const openRouter = card('OpenRouter')
    expect(screen.getByRole('button', { name: /^OpenRouter/ })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.change(within(openRouter).getByLabelText('Chave de API'), { target: { value: 'or-key' } })
    fireEvent.click(within(openRouter).getByRole('button', { name: 'Salvar chave' }))
    await within(openRouter).findByText('Guardada no chaveiro do sistema')

    fireEvent.click(within(openRouter).getByRole('button', { name: 'Remover provedor' }))
    fireEvent.click(within(openRouter).getByRole('button', { name: 'Confirmar remoção' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^OpenRouter/ })).not.toBeInTheDocument())
    expect(clearAgentApiKey).toHaveBeenCalledWith('openrouter')
  })
})
