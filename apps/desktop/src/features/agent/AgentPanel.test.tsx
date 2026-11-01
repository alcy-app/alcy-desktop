import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '../../test-utils'
import { EditorSelection, EditorState } from '@codemirror/state'
import { publishEditorSelection } from '../request-workbench/editor-bridge'
import type { AgentEventDto } from '../../bindings/agent-turn'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { WorkbenchAgentHost } from './agent-host'
import { AgentPanel } from './AgentPanel'
import { forgetRememberedSessions, rememberSession, rememberedSession } from './agent-session-memory'

const getAgentSettings = vi.fn()
const saveAgentSettings = vi.fn()
const startAgentTurn = vi.fn()
const compactAgentSession = vi.fn()
const cancelAgentTurn = vi.fn()
const submitAgentToolResult = vi.fn()
const loadAgentSession = vi.fn()
const notifyWhenUnfocused = vi.fn()

vi.mock('../../bindings/agent-settings', () => ({
  getAgentSettings: () => getAgentSettings(),
  saveAgentSettings: (...args: unknown[]) => saveAgentSettings(...args),
}))
vi.mock('../../bindings/agent-turn', () => ({
  startAgentTurn: (...args: unknown[]) => startAgentTurn(...args),
  submitAgentToolResult: (...args: unknown[]) => submitAgentToolResult(...args),
  cancelAgentTurn: (...args: unknown[]) => cancelAgentTurn(...args),
  compactAgentSession: (...args: unknown[]) => compactAgentSession(...args),
}))
vi.mock('../../bindings/system-notification', () => ({
  notifyWhenUnfocused: (...args: unknown[]) => notifyWhenUnfocused(...args),
}))
vi.mock('../../bindings/agent-sessions', () => ({
  listAgentSessions: vi.fn(async () => ({ ok: true, value: [] })),
  loadAgentSession: (...args: unknown[]) => loadAgentSession(...args),
  deleteAgentSession: vi.fn(),
}))

const claude = { id: 'claude', kind: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', hasApiKey: true }

function host(): WorkbenchAgentHost {
  const content = { ...emptyRequestContent('rest'), endpointUrl: 'https://api.example.com/users' }
  return {
    tabs: () => [{ id: 't1', name: 'Users', protocol: 'rest', requestId: null, dirty: true, isFlowNode: false, content, execution: { status: 'idle' } }],
    activeTabId: () => 't1',
    collections: () => [],
    environments: () => [],
    activeEnvironmentId: () => null,
    openRequest: vi.fn(),
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    highlight: vi.fn(),
    newRequestTab: vi.fn(),
    replaceContent: vi.fn(),
    send: vi.fn(async () => ({ status: 'error', error: { kind: 'timeout' } }) as const),
    saveTab: vi.fn(),
    importFromText: vi.fn(),
    createCollection: vi.fn(),
    createFolder: vi.fn(),
    setVariable: vi.fn(),
    setActiveEnvironment: vi.fn(),
  }
}

/** A turn that asks to send the active tab and ends once the tool result arrives. */
function scriptSendTurn(tool: Partial<Pick<Extract<AgentEventDto, { type: 'toolCallRequested' }>, 'name' | 'input' | 'class'>> = {}) {
  let finish: (value: unknown) => void = () => {}
  startAgentTurn.mockImplementation((_input: unknown, onEvent: (event: AgentEventDto) => void) => {
    onEvent({ type: 'sessionStarted', sessionId: 's1', title: 'Send it' })
    onEvent({ type: 'textDelta', text: 'Vou enviar.' })
    onEvent({ type: 'toolCallRequested', waitId: 'w1', callId: 'c1', name: 'send_request', input: {}, class: 'sideEffect', ...tool })
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  submitAgentToolResult.mockImplementation(async () => {
    finish({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    return { ok: true, value: undefined }
  })
}

/** Opens the context menu the only way left: typing @ in the composer. */
const typeMention = () => {
  const input = screen.getByLabelText('Mensagem para o agente') as HTMLTextAreaElement
  input.focus()
  fireEvent.change(input, { target: { value: '@' } })
}

const sendMessage = (text: string) => {
  fireEvent.change(screen.getByLabelText('Mensagem para o agente'), { target: { value: text } })
  fireEvent.keyDown(screen.getByLabelText('Mensagem para o agente'), { key: 'Enter' })
}

beforeEach(() => {
  forgetRememberedSessions()
  loadAgentSession.mockReset().mockResolvedValue({ ok: false, error: { kind: 'notFound' } })
  window.localStorage.removeItem('alcy:agent:approval-mode')
  getAgentSettings.mockReset()
  saveAgentSettings.mockReset()
  startAgentTurn.mockReset()
  compactAgentSession.mockReset().mockResolvedValue({ ok: true, value: { compacted: true, cancelled: false, inputTokens: 20, outputTokens: 5 } })
  cancelAgentTurn.mockReset().mockResolvedValue({ ok: true, value: undefined })
  submitAgentToolResult.mockReset()
  notifyWhenUnfocused.mockReset().mockResolvedValue(true)
})

describe('AgentPanel', () => {
  it('offers slash commands, filters them, completes with Tab and keeps unknown commands local', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    const input = screen.getByLabelText('Mensagem para o agente')
    fireEvent.change(input, { target: { value: '/' } })
    expect(screen.getByRole('listbox', { name: 'Comandos do chat' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /\/compact/ })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveValue('/')
    fireEvent.change(input, { target: { value: '/cl' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('/clear')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('')
    sendMessage('/unknown')
    expect(screen.getByRole('alert')).toHaveTextContent('Comando desconhecido')
    expect(startAgentTurn).not.toHaveBeenCalled()
    expect(compactAgentSession).not.toHaveBeenCalled()
    sendMessage('/clear extra')
    expect(input).toHaveValue('/clear extra')
    expect(screen.getByRole('alert')).toHaveTextContent('Comando desconhecido')
    fireEvent.change(input, { target: { value: 'Explique GET /users' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears the conversation and attachments without sending a command to the model', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('Mensagem anterior')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Novo chat' })).toBeEnabled())
    typeMention()
    fireEvent.keyDown(screen.getByLabelText('Mensagem para o agente'), { key: 'Enter' })
    expect(screen.getByRole('button', { name: '1 contexto' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Mensagem para o agente'), { target: { value: '/cl' } })
    fireEvent.click(screen.getByRole('option', { name: /\/clear/ }))
    expect(screen.queryByText('Mensagem anterior')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '1 contexto' })).not.toBeInTheDocument()
    expect(screen.getByText('Como posso ajudar?')).toBeInTheDocument()
    expect(screen.getByLabelText('Mensagem para o agente')).toHaveValue('')
    expect(startAgentTurn).toHaveBeenCalledTimes(1)
    sendMessage('Nova conversa')
    await waitFor(() => expect(startAgentTurn).toHaveBeenCalledTimes(2))
    expect(startAgentTurn.mock.calls[1][0]).toMatchObject({ sessionId: null, text: 'Nova conversa', context: [] })
  })

  it('keeps clear from being undone by a pending session restore', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    rememberSession('/w', 'old')
    let finish: (value: unknown) => void = () => {}
    loadAgentSession.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('/clear')
    await act(async () => finish({ ok: true, value: {
      id: 'old', title: 'Old chat', providerId: claude.id, model: claude.model, omittedItems: 0,
      totalTokens: { input: 1, output: 1 }, items: [{ kind: 'assistant', text: 'Old reply' }],
    } }))
    expect(screen.queryByText('Old reply')).not.toBeInTheDocument()
    expect(screen.getByText('Como posso ajudar?')).toBeInTheDocument()
    expect(rememberedSession('/w')).toBeNull()
  })

  it('compacts the current session with keyboard navigation and keeps its visible transcript', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('Preserve esta mensagem')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Novo chat' })).toBeEnabled())
    const input = screen.getByLabelText('Mensagem para o agente')
    fireEvent.change(input, { target: { value: '/' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /\/compact/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Contexto compactado. As mensagens continuam disponíveis nesta conversa.')).toBeInTheDocument()
    expect(compactAgentSession).toHaveBeenCalledWith({ runId: expect.any(String), rootPath: '/w', sessionId: 's1', providerId: claude.id, model: claude.model })
    expect(screen.getByText('Preserve esta mensagem')).toBeInTheDocument()
    expect(startAgentTurn).toHaveBeenCalledTimes(1)
    expect(screen.getByText('↑ 20 · ↓ 5 tokens')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('shows cancellable compaction progress and reports failure without losing the conversation', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 0, outputTokens: 0 } })
    let finish: (value: unknown) => void = () => {}
    compactAgentSession.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('Continue aqui')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Novo chat' })).toBeEnabled())
    sendMessage('/compact')
    expect(screen.getByRole('status')).toHaveTextContent('Compactando o contexto da conversa')
    expect(screen.getByRole('button', { name: 'Novo chat' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }))
    expect(cancelAgentTurn).toHaveBeenCalledWith(compactAgentSession.mock.calls[0][0].runId)
    act(() => finish({ ok: false, error: { kind: 'network', message: 'offline' } }))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    expect(screen.getByText('Continue aqui')).toBeInTheDocument()
    expect(startAgentTurn).toHaveBeenCalledTimes(1)
  })
  it('sends a suggested continuation once without consuming the composer draft and still asks for tool approval', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    rememberSession('/w', 's-old')
    loadAgentSession.mockResolvedValue({ ok: true, value: {
      id: 's-old', title: 'Users', providerId: 'claude', model: 'm', omittedItems: 0,
      items: [{ kind: 'assistant', text: 'Pronto.\n\n```alcy-suggestions\n["Envie a requisição"]\n```' }],
    } })
    scriptSendTurn()
    const workbench = host()
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    const suggestion = await screen.findByRole('button', { name: 'Envie a requisição' })
    const composer = screen.getByLabelText('Mensagem para o agente')
    fireEvent.change(composer, { target: { value: 'Um rascunho' } })
    fireEvent.click(suggestion)
    expect(await screen.findByRole('button', { name: 'Aprovar' })).toBeInTheDocument()
    expect(startAgentTurn).toHaveBeenCalledTimes(1)
    expect(startAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-old', text: 'Envie a requisição', context: [] }), expect.any(Function))
    expect(workbench.send).not.toHaveBeenCalled()
    expect(composer).toHaveValue('Um rascunho')
    expect(screen.getByRole('button', { name: 'Aprovar' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Envie a requisição' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }))
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalled())
  })

  it('shows thinking before the first response and removes it when text arrives or the turn ends', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    let emit: (event: AgentEventDto) => void = () => {}
    let finish: (value: unknown) => void = () => {}
    startAgentTurn.mockImplementation((_input: unknown, onEvent: (event: AgentEventDto) => void) => {
      emit = onEvent
      return new Promise((resolve) => { finish = resolve })
    })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('explique a API')
    expect(await screen.findByRole('status', { name: 'O Alcy está pensando' })).toBeInTheDocument()
    act(() => emit({ type: 'textDelta', text: 'Aqui está a explicação.' }))
    expect(screen.queryByRole('status', { name: 'O Alcy está pensando' })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'O agente está respondendo' })).toBeInTheDocument()
    await act(async () => finish({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } }))
    expect(screen.queryByRole('status', { name: 'O agente está respondendo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'O Alcy está pensando' })).not.toBeInTheDocument()
  })

  it('rejects a resource action if the target changes while approval is pending', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    scriptSendTurn({ name: 'delete_flow', input: { flowId: 'flow' } })
    const workbench = host()
    let revision = 'before'
    const call = vi.fn(async () => ({ content: '{}', isError: false }))
    workbench.resources = { call, context: () => [], summary: () => 'Example flow', fingerprint: () => revision }
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('exclua o flow')
    const approve = await screen.findByRole('button', { name: 'Aprovar' })
    revision = 'manual edit'
    fireEvent.click(approve)
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalledWith('w1', expect.stringContaining('changed while awaiting approval'), true))
    expect(call).not.toHaveBeenCalled()
  })

  it('routes new persisted actions through the existing auto-approval mode', async () => {
    window.localStorage.setItem('alcy:agent:approval-mode', 'autoApprove')
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    scriptSendTurn({ name: 'create_value_monitor', input: { name: 'Check names' } })
    const workbench = host()
    const call = vi.fn(async () => ({ content: '{"monitorId":"monitor"}', isError: false }))
    workbench.resources = { call, context: () => [], summary: () => 'Check names', fingerprint: () => 'current' }
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('crie o monitor')
    await waitFor(() => expect(call).toHaveBeenCalledWith('create_value_monitor', { name: 'Check names' }))
    expect(screen.queryByRole('button', { name: 'Aprovar' })).not.toBeInTheDocument()
    expect(await screen.findByText('aprovado automaticamente')).toBeInTheDocument()
  })

  it('navigates the provider menu, restores focus, and uses the selected provider', async () => {
    const local = { ...claude, id: 'local', label: 'Local', kind: 'openaiCompatible', model: 'local-model' }
    const providers = [claude, local]
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers, activeProviderId: claude.id } })
    saveAgentSettings.mockResolvedValue({ ok: true, value: { providers, activeProviderId: local.id } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    const trigger = await screen.findByRole('button', { name: 'Provedor e modelo' })
    expect(trigger).toHaveTextContent('Claude')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const current = screen.getByRole('menuitemradio', { name: 'Claude · claude-sonnet-5-5' })
    expect(current).toHaveAttribute('aria-checked', 'true')
    expect(current).toHaveFocus()
    fireEvent.keyDown(current, { key: 'ArrowDown' })
    const next = screen.getByRole('menuitemradio', { name: 'Local · local-model' })
    expect(next).toHaveFocus()
    fireEvent.keyDown(next, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(saveAgentSettings).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Local · local-model' }))
    await waitFor(() => expect(trigger).toHaveTextContent('Local'))
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(saveAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ activeProviderId: local.id }))
    fireEvent.pointerDown(document.body)
    expect(trigger).not.toHaveFocus()
    sendMessage('olá')
    expect(startAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ providerId: local.id, model: local.model }), expect.any(Function))
  })

  it('adds each turn cost under the answer and to the chat total, also when reopening a chat', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    startAgentTurn.mockImplementation(async (_input: unknown, onEvent: (event: AgentEventDto) => void) => {
      onEvent({ type: 'sessionStarted', sessionId: 's1', title: 'Oi' })
      onEvent({ type: 'textDelta', text: 'Olá!' })
      return { ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1200, outputTokens: 30 } }
    })
    const { unmount } = render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    expect(screen.queryByText('Nesta conversa')).not.toBeInTheDocument()
    sendMessage('oi')
    expect(await screen.findByText('↑ 1,2 mil · ↓ 30 tokens', { selector: '.agent-turn-tokens' })).toBeInTheDocument()
    sendMessage('e agora?')
    await waitFor(() => expect(screen.getByText('Nesta conversa').parentElement).toHaveTextContent('↑ 2,4 mil · ↓ 60 tokens'))
    unmount()

    rememberSession('/w', 's-old')
    loadAgentSession.mockResolvedValue({ ok: true, value: {
      id: 's-old', title: 'Users', providerId: 'claude', model: 'm', omittedItems: 0,
      items: [{ kind: 'user', text: 'oi' }, { kind: 'assistant', text: 'Olá!' }, { kind: 'usage', inputTokens: 900, outputTokens: 12 }],
      totalTokens: { input: 1500, output: 20 },
    } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('↑ 900 · ↓ 12 tokens', { selector: '.agent-turn-tokens' })).toBeInTheDocument()
    expect(screen.getByText('Nesta conversa').parentElement).toHaveTextContent('↑ 1,5 mil · ↓ 20 tokens')
  })

  it('closes the provider menu when clicking outside', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    const trigger = await screen.findByRole('button', { name: 'Provedor e modelo' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Claude/ })).toHaveFocus()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).not.toHaveFocus()
  })

  it('keeps the focus ring for the keyboard only', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    saveAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    const trigger = await screen.findByRole('button', { name: 'Provedor e modelo' })
    const picker = trigger.parentElement

    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(picker).toHaveAttribute('data-pointer-interaction')

    // A mouse choice neither restores the focus to the trigger nor leaves a ring behind.
    const option = screen.getByRole('menuitemradio', { name: /Claude/ })
    fireEvent.pointerDown(option)
    fireEvent.click(option, { detail: 1 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).not.toHaveFocus()

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(picker).not.toHaveAttribute('data-pointer-interaction')
    expect(screen.getByRole('menuitemradio', { name: /Claude/ })).toHaveFocus()
  })

  it('fills and focuses the composer from each prompt starter without sending', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    for (const name of ['Crie uma requisição GET…', 'Explique a resposta atual', 'Adicione um cabeçalho de autenticação a esta requisição']) {
      fireEvent.click(await screen.findByRole('button', { name }))
      expect(screen.getByLabelText('Mensagem para o agente')).toHaveValue(name)
      expect(screen.getByLabelText('Mensagem para o agente')).toHaveFocus()
    }
    expect(startAgentTurn).not.toHaveBeenCalled()
  })

  it('opens context by typing @ and attaches the highlighted item with the keyboard', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    typeMention()
    const input = screen.getByLabelText('Mensagem para o agente')
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.getByRole('listbox', { name: 'Adicionar contexto' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Users/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '1 contexto' }))
    expect(screen.getByLabelText('Contexto anexado')).toHaveTextContent('Users')
    sendMessage('explique')
    expect(startAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ context: [expect.objectContaining({ kind: 'tab', id: 't1' })] }), expect.any(Function))
  })

  it('browses context categories with the keyboard and attaches an environment', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    const workbench = host()
    workbench.environments = () => [{ id: 'dev', name: 'Development', variables: [] }]
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    typeMention()
    const input = screen.getByLabelText('Mensagem para o agente')
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.getByRole('option', { name: 'Coleções e requisições' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Abas abertas' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: 'Voltar aos contextos' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Users/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    expect(screen.getByRole('option', { name: 'Abas abertas' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Ambientes' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('option', { name: /Development/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '1 contexto' }))
    expect(screen.getByLabelText('Contexto anexado')).toHaveTextContent('Development')
    sendMessage('use este ambiente')
    expect(startAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ context: [expect.objectContaining({ kind: 'environment', id: 'dev' })] }), expect.any(Function))
  })

  it('searches across categories directly and returns from a category with the back action', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    const workbench = host()
    workbench.environments = () => [{ id: 'dev', name: 'Development', variables: [] }]
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    const input = screen.getByLabelText('Mensagem para o agente')
    fireEvent.change(input, { target: { value: '@' } })
    fireEvent.click(screen.getByRole('option', { name: 'Ambientes' }))
    expect(screen.getByRole('option', { name: /Development/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Voltar aos contextos' }))
    expect(screen.getByRole('option', { name: 'Ambientes' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(input, { target: { value: '@dev' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Development/ })).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '@missing' } })
    expect(screen.getByText('Nada encontrado')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(startAgentTurn).not.toHaveBeenCalled()
  })

  it('keeps context open through pointer-induced blur and selects with the mouse', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    const workbench = host()
    workbench.environments = () => [{ id: 'dev', name: 'Development', variables: [] }]
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    const input = screen.getByLabelText('Mensagem para o agente')
    typeMention()
    await waitFor(() => expect(input).toHaveFocus())

    const category = screen.getByRole('option', { name: 'Ambientes' })
    fireEvent.pointerDown(category)
    fireEvent.blur(input, { relatedTarget: category })
    fireEvent.focusIn(category)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.mouseDown(category)
    fireEvent.pointerUp(category)
    fireEvent.mouseUp(category)
    fireEvent.click(category)

    const environment = screen.getByRole('option', { name: /Development/ })
    fireEvent.pointerDown(environment)
    fireEvent.blur(input, { relatedTarget: null })
    fireEvent.focusIn(environment)
    expect(screen.getByRole('listbox', { name: 'Ambientes' })).toBeInTheDocument()
    fireEvent.mouseDown(environment)
    fireEvent.pointerUp(environment)
    fireEvent.mouseUp(environment)
    fireEvent.click(environment)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '1 contexto' }))
    expect(screen.getByLabelText('Contexto anexado')).toHaveTextContent('Development')
    await waitFor(() => expect(input).toHaveFocus())

    typeMention()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('keeps Shift+Enter and composition from sending a message', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    const input = screen.getByLabelText('Mensagem para o agente')
    fireEvent.change(input, { target: { value: 'olá' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(startAgentTurn).not.toHaveBeenCalled()
    expect(input).toHaveValue('olá')
  })

  it('turns pasted JSON into a json block and pastes other text normally', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    const input = screen.getByLabelText('Mensagem para o agente') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Valide:' } })
    input.setSelectionRange(7, 7)
    const paste = (text: string) => fireEvent.paste(input, { clipboardData: { getData: () => text } })
    expect(paste('{"id": 1}')).toBe(false)
    expect(input).toHaveValue('Valide:\n```json\n{"id": 1}\n```\n')
    expect(paste('texto')).toBe(true)
    expect(input).toHaveAttribute('spellcheck', 'false')
  })

  it('groups full messages and editable excerpts, preserves the draft, and sends only the native context fields', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    startAgentTurn.mockImplementation(async (_input: unknown, onEvent: (event: AgentEventDto) => void) => {
      onEvent({ type: 'textDelta', text: 'O campo **status** indica uma falha.' })
      return { ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } }
    })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('Explique o status')
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Responder à mensagem completa' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Responder à mensagem completa' })[1])
    const composer = screen.getByLabelText('Mensagem para o agente')
    fireEvent.change(composer, { target: { value: 'Meu rascunho' } })
    const word = screen.getByText('status', { selector: 'strong' })
    const range = document.createRange()
    range.selectNodeContents(word)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(screen.getByRole('log'), { clientX: 20, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Usar como contexto' }))
    window.getSelection()?.removeAllRanges()
    expect(composer).toHaveValue('Meu rascunho')
    const grouped = screen.getByRole('button', { name: '2 contextos' })
    expect(grouped).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(grouped)
    expect(screen.getByText('Resposta completa')).toBeInTheDocument()
    expect(screen.getByText('Texto selecionado')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Editar trecho 2' }))
    const editor = screen.getByRole('textbox', { name: 'Editar texto selecionado' })
    expect(editor).toHaveFocus()
    fireEvent.change(editor, { target: { value: 'status revisado' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(screen.getByText('status revisado')).toBeInTheDocument()
    fireEvent.keyDown(grouped, { key: 'Escape' })
    expect(grouped).toHaveFocus()
    expect(grouped).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Contexto anexado' })).not.toBeInTheDocument()
    sendMessage('Use os contextos')
    await waitFor(() => expect(startAgentTurn).toHaveBeenCalledTimes(2))
    const [input] = startAgentTurn.mock.calls[1] as [{ context: Record<string, unknown>[] }]
    expect(input.context).toEqual([
      { kind: 'quote', id: expect.any(String), label: expect.stringContaining('Resposta'), summary: 'O campo **status** indica uma falha.' },
      { kind: 'quote', id: expect.any(String), label: 'Trecho: “status”', summary: 'status revisado' },
    ])
    expect(screen.queryByRole('button', { name: '2 contextos' })).not.toBeInTheDocument()
  })

  it('removes one attached context or clears the group and restores composer focus', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: claude.id } })
    const workbench = host()
    workbench.environments = () => [{ id: 'dev', name: 'Development', variables: [] }]
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    typeMention()
    fireEvent.keyDown(screen.getByLabelText('Mensagem para o agente'), { key: 'Enter' })
    typeMention()
    fireEvent.click(screen.getByRole('option', { name: 'Ambientes' }))
    fireEvent.click(screen.getByRole('option', { name: /Development/ }))
    fireEvent.click(screen.getByRole('button', { name: '2 contextos' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remover Users do contexto' }))
    expect(screen.getByRole('button', { name: '1 contexto' })).toHaveFocus()
    expect(screen.queryByText('Users')).not.toBeInTheDocument()
    expect(screen.getByText('Development')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remover todos os contextos' }))
    expect(screen.queryByRole('button', { name: '1 contexto' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Mensagem para o agente')).toHaveFocus()
  })

  it('sends the editor selection first in the context, once, and lets it be dismissed', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    act(() => publishEditorSelection('response', EditorState.create({ doc: '{"status":"failed"}', selection: EditorSelection.single(11, 17) })))
    fireEvent.click(await screen.findByRole('button', { name: '1 contexto' }))
    expect(screen.getByText(/Seleção em corpo da resposta/)).toBeInTheDocument()

    sendMessage('por que falhou?')
    await waitFor(() => expect(startAgentTurn).toHaveBeenCalled())
    const [input] = startAgentTurn.mock.calls[0] as [{ context: { kind: string; summary: string }[] }]
    expect(input.context[0].kind).toBe('selection')
    expect(input.context[0].summary).toContain('Response body of tab "Users"')
    expect(input.context[0].summary).toContain('failed')
    await waitFor(() => expect(screen.queryByRole('button', { name: '1 contexto' })).not.toBeInTheDocument())

    act(() => publishEditorSelection('response', EditorState.create({ doc: '{"status":"failed"}', selection: EditorSelection.single(2, 8) })))
    fireEvent.click(await screen.findByRole('button', { name: '1 contexto' }))
    fireEvent.click(screen.getByRole('button', { name: /Remover Seleção em corpo da resposta do contexto/ }))
    expect(screen.queryByRole('button', { name: '1 contexto' })).not.toBeInTheDocument()
    act(() => publishEditorSelection('response', EditorState.create({ doc: '{}', selection: EditorSelection.single(0, 0) })))
  })

  it('tells when the chat was summarized and names keyring failures', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    startAgentTurn.mockImplementationOnce(async (_input: unknown, onEvent: (event: AgentEventDto) => void) => {
      onEvent({ type: 'contextCompacted' })
      onEvent({ type: 'textDelta', text: 'Continuando.' })
      return { ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } }
    })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    sendMessage('continue')
    expect(await screen.findByText(/foi resumida para caber no contexto/)).toBeInTheDocument()
    expect(await screen.findByText('Continuando.')).toBeInTheDocument()

    startAgentTurn.mockResolvedValueOnce({ ok: false, error: { kind: 'credentials', message: 'Server GUID mismatch' } })
    sendMessage('de novo')
    expect(await screen.findByRole('alert')).toHaveTextContent('O chaveiro do sistema não está disponível: Server GUID mismatch')
  })

  it('notifies the system when an action waits for approval, not when it is approved automatically', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    scriptSendTurn()
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('envie')
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }))
    expect(notifyWhenUnfocused).toHaveBeenCalledTimes(1)
    expect(notifyWhenUnfocused).toHaveBeenCalledWith('O Alcy precisa da sua aprovação', expect.stringMatching(/^Enviar a requisição/))
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Modo de aprovação' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Auto-aprovação' }))
    scriptSendTurn()
    sendMessage('envie de novo')
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalledTimes(2))
    expect(notifyWhenUnfocused).toHaveBeenCalledTimes(1)
  })

  it('runs side effects without asking in auto-approve mode and remembers the mode', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    scriptSendTurn()
    const workbench = host()
    const { unmount } = render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    fireEvent.click(screen.getByRole('button', { name: 'Modo de aprovação' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Auto-aprovação' }))
    expect(screen.getByRole('button', { name: 'Modo de aprovação' })).toHaveTextContent('Auto-aprovação')

    sendMessage('envie')
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalledWith('w1', expect.any(String), false))
    expect(workbench.send).toHaveBeenCalledWith('t1')
    expect(screen.queryByRole('button', { name: 'Aprovar' })).not.toBeInTheDocument()
    expect(await screen.findByText('aprovado automaticamente')).toBeInTheDocument()

    unmount()
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Modo de aprovação' })).toHaveTextContent('Auto-aprovação')
  })

  it('approves what is waiting when switching to auto-approve', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    scriptSendTurn()
    const workbench = host()
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    sendMessage('envie')
    expect(await screen.findByRole('button', { name: 'Aprovar' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Modo de aprovação' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Auto-aprovação' }))
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalledWith('w1', expect.any(String), false))
    expect(workbench.send).toHaveBeenCalledWith('t1')
  })

  it('opens the agent settings from the end of the provider menu', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    const onOpenSettings = vi.fn()
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={onOpenSettings} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    fireEvent.click(screen.getByRole('button', { name: 'Provedor e modelo' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Configurar provedores…' }))
    expect(onOpenSettings).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('reopens the chat last open in the workspace and remembers new ones', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    rememberSession('/w', 's-old')
    rememberSession('/other', 's-other')
    loadAgentSession.mockResolvedValue({
      ok: true,
      value: { id: 's-old', title: 'Users API', providerId: 'claude', model: 'm', omittedItems: 0, items: [{ kind: 'user', text: 'liste os usuários' }] },
    })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)

    expect(await screen.findByText('liste os usuários')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Users API' })).toBeInTheDocument()
    expect(loadAgentSession).toHaveBeenCalledWith('/w', 's-old')

    fireEvent.click(screen.getByRole('button', { name: 'Novo chat' }))
    expect(rememberedSession('/w')).toBeNull()
    expect(rememberedSession('/other')).toBe('s-other')
  })

  it('forgets a remembered chat that no longer exists, without an error', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    rememberSession('/w', 'gone')
    loadAgentSession.mockResolvedValue({ ok: false, error: { kind: 'notFound' } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)

    await screen.findByText('Como posso ajudar?')
    await waitFor(() => expect(rememberedSession('/w')).toBeNull())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('starts a new chat instead of reopening the previous one when the app starts again', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    startAgentTurn.mockImplementation(async (_input: unknown, onEvent: (event: AgentEventDto) => void) => {
      onEvent({ type: 'sessionStarted', sessionId: 's1', title: 'Conversa anterior' })
      onEvent({ type: 'textDelta', text: 'Tudo certo.' })
      return { ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } }
    })
    const { unmount } = render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')
    sendMessage('Mensagem anterior')
    expect(await screen.findByText('Tudo certo.')).toBeInTheDocument()
    await waitFor(() => expect(rememberedSession('/w')).toBe('s1'))
    unmount()

    // Starting the app again drops the in-memory memory of the last chat.
    forgetRememberedSessions()
    loadAgentSession.mockClear()
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)

    expect(await screen.findByText('Como posso ajudar?')).toBeInTheDocument()
    expect(screen.queryByText('Mensagem anterior')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Novo chat' })).toBeInTheDocument()
    expect(loadAgentSession).not.toHaveBeenCalled()
  })

  it('asks to set up a provider before chatting', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [{ ...claude, hasApiKey: false }], activeProviderId: null } })
    const onOpenSettings = vi.fn()
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={onOpenSettings} onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Configurar agente' }))
    expect(onOpenSettings).toHaveBeenCalled()
    expect(screen.getByLabelText('Mensagem para o agente')).toBeDisabled()
  })

  it('runs a side effect only after the user approves it', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    scriptSendTurn()
    const workbench = host()
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    sendMessage('envie a requisição')
    expect(await screen.findByText('Vou enviar.')).toBeInTheDocument()
    expect(startAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude', model: 'claude-sonnet-5-5', text: 'envie a requisição', rootPath: '/w' }),
      expect.any(Function),
    )
    expect(workbench.send).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Provedor e modelo' })).toBeDisabled()

    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }))
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalledWith('w1', expect.stringContaining('failed'), false))
    expect(workbench.send).toHaveBeenCalledWith('t1')
    expect(await screen.findByRole('heading', { name: 'Send it' })).toBeInTheDocument()
  })

  it('reports a declined side effect to the model without running it', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    scriptSendTurn()
    const workbench = host()
    render(<AgentPanel rootPath="/w" host={workbench} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    sendMessage('envie')
    fireEvent.click(await screen.findByRole('button', { name: 'Recusar' }))
    await waitFor(() => expect(submitAgentToolResult).toHaveBeenCalledWith('w1', expect.stringContaining('declined'), true))
    expect(workbench.send).not.toHaveBeenCalled()
    expect(await screen.findByText('recusado')).toBeInTheDocument()
  })

  it('shows provider errors in the chat', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    startAgentTurn.mockResolvedValue({ ok: false, error: { kind: 'unauthorized' } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    sendMessage('oi')
    expect(await screen.findByRole('alert')).toHaveTextContent('recusou a chave de API')
  })
})
