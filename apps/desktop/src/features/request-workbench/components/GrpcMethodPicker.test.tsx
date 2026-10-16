import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import type { GrpcSchemaSummary } from '../../../bindings/load-grpc-schema'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
import { GrpcMethodPicker } from './GrpcMethodPicker'

const method = (name: string, kind: 'unary' | 'serverStreaming' | 'clientStreaming' | 'bidiStreaming') => ({
  name,
  kind,
  inputType: 'test.Req',
  outputType: 'test.Res',
  inputTemplate: '{}',
  inputSchema: {},
})

const schema: GrpcSchemaSummary = {
  services: [
    { name: 'test.Greeter', methods: [method('SayHello', 'unary'), method('LotsOfReplies', 'serverStreaming')] },
    { name: 'test.Chat', methods: [method('Talk', 'bidiStreaming')] },
  ],
}

function renderPicker(state: GrpcSchemaLoadState, props: Partial<Parameters<typeof GrpcMethodPicker>[0]> = {}) {
  const onSelect = vi.fn()
  const onLoad = vi.fn()
  render(<GrpcMethodPicker schema={state} service="" method="" onSelect={onSelect} onLoad={onLoad} {...props} />)
  return { onSelect, onLoad }
}

describe('GrpcMethodPicker', () => {
  it('loads the services the first time it opens', () => {
    const { onLoad } = renderPicker({ status: 'idle' })
    const trigger = screen.getByRole('button', { name: 'Método gRPC' })
    expect(trigger).toHaveTextContent('Escolher método')

    fireEvent.click(trigger)

    expect(onLoad).toHaveBeenCalledWith(false)
    expect(screen.getByRole('dialog', { name: 'Método gRPC' })).toHaveTextContent('Carregando serviços…')
  })

  it('lists methods grouped by service, filters them and selects one', () => {
    const { onSelect, onLoad } = renderPicker({ status: 'success', schema })
    fireEvent.click(screen.getByRole('button', { name: 'Método gRPC' }))
    expect(onLoad).not.toHaveBeenCalled()

    const list = screen.getByRole('listbox', { name: 'Método gRPC' })
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'SayHello→ Unário',
      'LotsOfReplies↓ Stream do servidor',
      'Talk⇅ Bidirecional',
    ])
    expect(list).toHaveTextContent('test.Greeter')
    expect(list).toHaveTextContent('test.Chat')

    const search = screen.getByRole('textbox', { name: 'Buscar serviço ou método' })
    expect(screen.queryByRole('button', { name: 'Recarregar serviços' })).not.toBeInTheDocument()
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: 'chat' } })
    expect(within(list).getAllByRole('option')).toHaveLength(1)

    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('test.Chat', 'Talk')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the chosen method and the load errors', () => {
    renderPicker({ status: 'error', error: { kind: 'schema', message: 'no reflection' } }, { service: 'test.Greeter', method: 'SayHello' })
    const trigger = screen.getByRole('button', { name: 'Método gRPC' })
    expect(trigger).toHaveTextContent('GreeterSayHello')

    fireEvent.click(trigger)
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar os serviços gRPC: no reflection')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
