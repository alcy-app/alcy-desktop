import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../test-utils'
import {
  clearMockCalls, getMockServer, listMockCalls, listMockServers, saveMockServer, startMockServer,
  type MockRouteDto, type MockServerDto,
} from '../../bindings/mock-servers'
import { MockServerEditor } from './MockServerEditor'

vi.mock('../../bindings/mock-servers', () => ({
  getMockServer: vi.fn(), listMockServers: vi.fn(), listMockCalls: vi.fn(),
  saveMockServer: vi.fn(), startMockServer: vi.fn(), stopMockServer: vi.fn(),
  deleteMockServer: vi.fn(), clearMockCalls: vi.fn(),
}))

// A suíte exercita navegação e rascunhos; o editor de código tem sua própria cobertura.
vi.mock('../request-workbench/components/RequestBodyPanel', () => ({
  RequestBodyPanel: ({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) =>
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />,
}))

const route = (id: string, name: string, path: string): MockRouteDto => ({
  id, name, path, enabled: true, method: 'GET', alternatives: [],
  defaultResponse: { id: id + '-default', name: 'Resposta padrão', enabled: true, status: 200, delayMs: 0, body: '{}', headers: [{ name: 'content-type', value: 'application/json' }], condition: null },
})

let server: MockServerDto
const props = { rootPath: '/workspace', serverId: 'mock-api', onTabChange: vi.fn(), onDeleted: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  server = { id: 'mock-api', name: 'API local', port: 3001, corsEnabled: true, routes: [route('users', 'Usuários', '/users'), route('health', 'Saúde', '/health')] }
  vi.mocked(getMockServer).mockResolvedValue({ ok: true, value: server })
  vi.mocked(listMockServers).mockResolvedValue({ ok: true, value: { servers: [{ id: server.id, name: server.name, port: server.port, routesCount: 2, running: false }] } })
  vi.mocked(listMockCalls).mockResolvedValue({ ok: true, value: [] })
  vi.mocked(saveMockServer).mockResolvedValue({ ok: true, value: undefined })
  vi.mocked(startMockServer).mockResolvedValue({ ok: true, value: undefined })
  vi.mocked(clearMockCalls).mockResolvedValue({ ok: true, value: undefined })
})

async function openEditor() {
  const result = render(<MockServerEditor {...props} />)
  await screen.findByRole('heading', { name: 'API local' })
  return result
}

describe('MockServerEditor', () => {
  it('edita uma rota por vez e preserva seu rascunho ao navegar entre rotas e seções', async () => {
    await openEditor()
    expect(screen.getByLabelText('Caminho da rota')).toHaveValue('/users')
    fireEvent.change(screen.getByLabelText('Corpo da resposta'), { target: { value: '{"name":"Ana"}' } })

    fireEvent.click(screen.getByRole('button', { name: /^GET Saúde/ }))
    expect(screen.getByLabelText('Caminho da rota')).toHaveValue('/health')
    expect(screen.getByLabelText('Corpo da resposta')).toHaveValue('{}')
    fireEvent.click(screen.getByRole('tab', { name: 'Configurações' }))
    expect(screen.queryByLabelText('Caminho da rota')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Nome do servidor'), { target: { value: 'API de testes' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Rotas' }))
    fireEvent.click(screen.getByRole('button', { name: /^GET Usuários/ }))
    expect(screen.getByLabelText('Corpo da resposta')).toHaveValue('{"name":"Ana"}')

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveMockServer).toHaveBeenCalled())
    const saved = vi.mocked(saveMockServer).mock.calls[0][1]
    expect(saved.name).toBe('API de testes')
    expect(saved.routes[0].defaultResponse.body).toBe('{"name":"Ana"}')
    expect(saved.routes[1].defaultResponse.body).toBe('{}')
  })

  it('filtra endpoints e seleciona uma rota recém-criada sem apagar as existentes', async () => {
    await openEditor()
    fireEvent.change(screen.getByLabelText('Buscar rotas'), { target: { value: '/health' } })
    expect(screen.queryByRole('button', { name: /^GET Usuários/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^GET Saúde/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar rota' }))
    expect(screen.getByLabelText('Nome da rota')).toHaveValue('Nova rota')
    expect(screen.getByLabelText('Caminho da rota')).toHaveValue('/')
    expect(screen.getByLabelText('Buscar rotas')).toHaveValue('')
    expect(screen.getByRole('button', { name: /^GET Usuários/ })).toBeInTheDocument()
  })

  it('mantém alterações ao esconder e reativar a aba e salva somente a aba ativa pelo atalho', async () => {
    const result = await openEditor()
    fireEvent.change(screen.getByLabelText('Corpo da resposta'), { target: { value: '{"draft":true}' } })
    result.rerender(<MockServerEditor {...props} active={false} />)
    fireEvent.keyDown(document, { ctrlKey: true, key: 's' })
    expect(saveMockServer).not.toHaveBeenCalled()
    result.rerender(<MockServerEditor {...props} active />)
    expect(screen.getByLabelText('Corpo da resposta')).toHaveValue('{"draft":true}')
    fireEvent.keyDown(document, { ctrlKey: true, key: 's' })
    await waitFor(() => expect(saveMockServer).toHaveBeenCalled())
    expect(vi.mocked(saveMockServer).mock.calls[0][1].routes[0].defaultResponse.body).toBe('{"draft":true}')
  })

  it('preserva regras inválidas entre submenus e bloqueia salvar até corrigir o JSON', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Resposta condicional' }))
    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }))
    fireEvent.change(screen.getByLabelText('Regras da resposta'), { target: { value: '{inválido' } })
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Visual' })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Corpo' }))
    fireEvent.click(screen.getByRole('button', { name: /^GET Saúde/ }))
    fireEvent.click(screen.getByRole('button', { name: /^GET Usuários/ }))
    const responseSelect = screen.getByRole('combobox', { name: 'Resposta da rota' })
    const option = screen.getByRole('option', { name: /Alternativa 1/ }) as HTMLOptionElement
    fireEvent.change(responseSelect, { target: { value: option.value } })
    fireEvent.click(screen.getByRole('tab', { name: 'Regras' }))
    expect(screen.getByLabelText('Regras da resposta')).toHaveValue('{inválido')
    const rules = '{"operator":"all","conditions":[{"kind":"match","source":"query","key":"role","operator":"equals","value":"admin"}]}'
    fireEvent.change(screen.getByLabelText('Regras da resposta'), { target: { value: rules } })
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    fireEvent.change(screen.getByLabelText('Valor do header 1'), { target: { value: 'text/plain' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveMockServer).toHaveBeenCalled())
    const response = vi.mocked(saveMockServer).mock.calls[0][1].routes[0].alternatives[0]
    expect(response.condition).toEqual(JSON.parse(rules))
    expect(response.headers[0].value).toBe('text/plain')
    expect(server.routes[0].defaultResponse.headers[0].value).toBe('application/json')
  })

  it('cria regras pelo editor visual, sem JSON, como modo padrão das respostas condicionais', async () => {
    server.routes[0].path = '/users/:id'
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Resposta condicional' }))
    expect(screen.getByRole('radio', { name: 'Visual' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByLabelText('Regras da resposta')).not.toBeInTheDocument()
    expect(screen.getByText('Sem regras, esta resposta não é usada.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar regra' }))
    fireEvent.change(screen.getByLabelText('Origem da regra 1'), { target: { value: 'pathParameter' } })
    expect(screen.getByLabelText('Chave da regra 1')).toHaveAttribute('list')
    fireEvent.change(screen.getByLabelText('Chave da regra 1'), { target: { value: 'id' } })
    fireEvent.change(screen.getByLabelText('Valor da regra 1'), { target: { value: '42' } })

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar grupo' }))
    expect(screen.queryByLabelText('Combinação do grupo 2')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Combinação das regras'), { target: { value: 'any' } })
    expect(within(screen.getByRole('group', { name: 'Grupo 2' })).getByLabelText('Origem da regra 2.1')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Origem da regra 2.1'), { target: { value: 'header' } })
    fireEvent.change(screen.getByLabelText('Chave da regra 2.1'), { target: { value: 'authorization' } })
    fireEvent.change(screen.getByLabelText('Operador da regra 2.1'), { target: { value: 'exists' } })
    expect(screen.queryByLabelText('Valor da regra 2.1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }))
    expect(JSON.parse((screen.getByLabelText('Regras da resposta') as HTMLTextAreaElement).value).conditions).toHaveLength(2)
    fireEvent.click(screen.getByRole('radio', { name: 'Visual' }))
    expect(screen.getByLabelText('Valor da regra 1')).toHaveValue('42')

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(saveMockServer).toHaveBeenCalled())
    expect(vi.mocked(saveMockServer).mock.calls[0][1].routes[0].alternatives[0].condition).toEqual({
      operator: 'any',
      conditions: [
        { kind: 'match', source: 'pathParameter', key: 'id', operator: 'equals', value: '42' },
        { kind: 'group', group: { operator: 'all', conditions: [{ kind: 'match', source: 'header', key: 'authorization', operator: 'exists', value: '' }] } },
      ],
    })
  })

  it('atualiza o estado ao iniciar e bloqueia a porta enquanto o servidor estiver ativo', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar' }))
    await screen.findByText('Em execução')
    expect(startMockServer).toHaveBeenCalledWith('/workspace', 'mock-api')
    fireEvent.click(screen.getByRole('tab', { name: 'Configurações' }))
    expect(screen.getByLabelText('Porta do servidor')).toBeDisabled()
    expect(screen.getByLabelText('Host do servidor')).toHaveValue('127.0.0.1')
  })

  it('abre as chamadas em uma seção própria, mostra a resposta escolhida e limpa os registros', async () => {
    vi.mocked(listMockCalls).mockResolvedValue({ ok: true, value: [{ id: 1, method: 'GET', path: '/users', routeId: 'route-1', routeName: 'Usuários', responseName: 'Administrador', status: 200, durationMs: 12 }] })
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'Chamadas' }))
    expect(await screen.findByText('Administrador')).toBeInTheDocument()
    expect(screen.getByText('12 ms')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }))
    await screen.findByRole('heading', { name: 'Nenhuma chamada recebida' })
    expect(clearMockCalls).toHaveBeenCalledWith('/workspace', 'mock-api')
  })
})
