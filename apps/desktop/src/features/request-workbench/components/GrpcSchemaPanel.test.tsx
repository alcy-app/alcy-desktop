import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import { emptyGrpcCall, type GrpcCallState } from '../collection-tree'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
import { GrpcSchemaPanel } from './GrpcSchemaPanel'

function Harness({ schema = { status: 'idle' }, onLoad = vi.fn(), pickFiles, pickFolder }: {
  schema?: GrpcSchemaLoadState
  onLoad?: (forceRefresh: boolean) => void
  pickFiles?: () => Promise<string[]>
  pickFolder?: () => Promise<string | null>
}) {
  const [grpc, setGrpc] = useState<GrpcCallState>(emptyGrpcCall)
  return (
    <>
      <GrpcSchemaPanel
        grpc={grpc}
        onChange={(patch) => setGrpc((current) => ({ ...current, ...patch }))}
        schema={schema}
        onLoad={onLoad}
        rootPath="/ws"
        pickFiles={pickFiles}
        pickFolder={pickFolder}
      />
      <output data-testid="state">{JSON.stringify(grpc)}</output>
    </>
  )
}

const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as GrpcCallState

describe('GrpcSchemaPanel', () => {
  it('switches to .proto files, keeping workspace files relative', async () => {
    const pickFiles = vi.fn().mockResolvedValue(['/ws/protos/greeter.proto', '/elsewhere/common.proto'])
    const pickFolder = vi.fn().mockResolvedValue('/ws/third_party')
    render(<Harness pickFiles={pickFiles} pickFolder={pickFolder} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Arquivos .proto' }))
    expect(screen.getByText('Nenhum arquivo escolhido.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar arquivos .proto' }))
    await waitFor(() =>
      expect(state().schemaSource).toEqual({
        type: 'protoFiles',
        files: ['protos/greeter.proto', '/elsewhere/common.proto'],
        importPaths: [],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar pasta de imports' }))
    await waitFor(() => expect(state().schemaSource).toMatchObject({ importPaths: ['third_party'] }))

    fireEvent.click(screen.getByRole('button', { name: 'Remover protos/greeter.proto' }))
    expect(state().schemaSource).toMatchObject({ files: ['/elsewhere/common.proto'] })
  })

  it('loads services, selects a method and sets the deadline', () => {
    const onLoad = vi.fn()
    const schema: GrpcSchemaLoadState = {
      status: 'success',
      schema: {
        services: [
          {
            name: 'test.Greeter',
            methods: [{ name: 'SayHello', kind: 'unary', inputType: 'test.Req', outputType: 'test.Res', inputTemplate: '{}', inputSchema: {} }],
          },
        ],
      },
    }
    render(<Harness schema={schema} onLoad={onLoad} />)

    fireEvent.click(screen.getByRole('button', { name: 'Recarregar serviços' }))
    expect(onLoad).toHaveBeenCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: /SayHello/ }))
    expect(state()).toMatchObject({ service: 'test.Greeter', method: 'SayHello' })

    fireEvent.change(screen.getByLabelText('Deadline (ms)'), { target: { value: '1500' } })
    expect(state().deadlineMs).toBe(1500)
    fireEvent.change(screen.getByLabelText('Deadline (ms)'), { target: { value: '' } })
    expect(state().deadlineMs).toBeNull()
  })
})
