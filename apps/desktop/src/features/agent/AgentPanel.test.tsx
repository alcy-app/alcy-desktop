import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '../../test-utils'
import { EditorSelection, EditorState } from '@codemirror/state'
import { publishEditorSelection } from '../request-workbench/editor-bridge'
import type { AgentEventDto } from '../../bindings/agent-turn'
import { emptyRequestContent } from '../request-workbench/collection-tree'
import type { WorkbenchAgentHost } from './agent-host'
import { AgentPanel } from './AgentPanel'

const getAgentSettings = vi.fn()
const saveAgentSettings = vi.fn()
const startAgentTurn = vi.fn()
const submitAgentToolResult = vi.fn()
const loadAgentSession = vi.fn()

vi.mock('../../bindings/agent-settings', () => ({
  getAgentSettings: () => getAgentSettings(),
  saveAgentSettings: (...args: unknown[]) => saveAgentSettings(...args),
}))
vi.mock('../../bindings/agent-turn', () => ({
  startAgentTurn: (...args: unknown[]) => startAgentTurn(...args),
  submitAgentToolResult: (...args: unknown[]) => submitAgentToolResult(...args),
  cancelAgentTurn: vi.fn(async () => ({ ok: true, value: undefined })),
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
    createCollection: vi.fn(),
    createFolder: vi.fn(),
    setVariable: vi.fn(),
    setActiveEnvironment: vi.fn(),
  }
}

/** A turn that asks to send the active tab and ends once the tool result arrives. */
function scriptSendTurn() {
  let finish: (value: unknown) => void = () => {}
  startAgentTurn.mockImplementation((_input: unknown, onEvent: (event: AgentEventDto) => void) => {
    onEvent({ type: 'sessionStarted', sessionId: 's1', title: 'Send it' })
    onEvent({ type: 'textDelta', text: 'Vou enviar.' })
    onEvent({ type: 'toolCallRequested', waitId: 'w1', callId: 'c1', name: 'send_request', input: {}, class: 'sideEffect' })
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
  loadAgentSession.mockReset().mockResolvedValue({ ok: false, error: { kind: 'notFound' } })
  window.localStorage.removeItem('alcy:agent:approval-mode')
  getAgentSettings.mockReset()
  saveAgentSettings.mockReset()
  startAgentTurn.mockReset()
  submitAgentToolResult.mockReset()
})

describe('AgentPanel', () => {
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

  it('sends the editor selection first in the context, once, and lets it be dismissed', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    startAgentTurn.mockResolvedValue({ ok: true, value: { sessionId: 's1', stopReason: 'endTurn', inputTokens: 1, outputTokens: 1 } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)
    await screen.findByText('Como posso ajudar?')

    act(() => publishEditorSelection('response', EditorState.create({ doc: '{"status":"failed"}', selection: EditorSelection.single(11, 17) })))
    expect(await screen.findByText(/Seleção em corpo da resposta/)).toBeInTheDocument()

    sendMessage('por que falhou?')
    await waitFor(() => expect(startAgentTurn).toHaveBeenCalled())
    const [input] = startAgentTurn.mock.calls[0] as [{ context: { kind: string; summary: string }[] }]
    expect(input.context[0].kind).toBe('selection')
    expect(input.context[0].summary).toContain('Response body of tab "Users"')
    expect(input.context[0].summary).toContain('failed')
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Contexto anexado' })).not.toBeInTheDocument())

    act(() => publishEditorSelection('response', EditorState.create({ doc: '{"status":"failed"}', selection: EditorSelection.single(2, 8) })))
    fireEvent.click(await screen.findByRole('button', { name: /Remover Seleção em corpo da resposta do contexto/ }))
    expect(screen.queryByRole('list', { name: 'Contexto anexado' })).not.toBeInTheDocument()
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
    window.localStorage.setItem('alcy:agent:sessions', JSON.stringify({ '/w': 's-old', '/other': 's-other' }))
    loadAgentSession.mockResolvedValue({
      ok: true,
      value: { id: 's-old', title: 'Users API', providerId: 'claude', model: 'm', omittedItems: 0, items: [{ kind: 'user', text: 'liste os usuários' }] },
    })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)

    expect(await screen.findByText('liste os usuários')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Users API' })).toBeInTheDocument()
    expect(loadAgentSession).toHaveBeenCalledWith('/w', 's-old')

    fireEvent.click(screen.getByRole('button', { name: 'Novo chat' }))
    expect(JSON.parse(window.localStorage.getItem('alcy:agent:sessions') ?? '{}')).toEqual({ '/other': 's-other' })
  })

  it('forgets a remembered chat that no longer exists, without an error', async () => {
    getAgentSettings.mockResolvedValue({ ok: true, value: { providers: [claude], activeProviderId: 'claude' } })
    window.localStorage.setItem('alcy:agent:sessions', JSON.stringify({ '/w': 'gone' }))
    loadAgentSession.mockResolvedValue({ ok: false, error: { kind: 'notFound' } })
    render(<AgentPanel rootPath="/w" host={host()} settingsOpen={false} onOpenSettings={() => {}} onClose={() => {}} />)

    await screen.findByText('Como posso ajudar?')
    await waitFor(() => expect(window.localStorage.getItem('alcy:agent:sessions')).toBe('{}'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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
