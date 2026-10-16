import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../test-utils'
import { emptyGrpcCall, type GrpcCallState } from '../collection-tree'
import { GrpcSchemaControls } from './GrpcSchemaControls'

function Harness() {
  const [grpc, setGrpc] = useState<GrpcCallState>(emptyGrpcCall)
  return <GrpcSchemaControls grpc={grpc} onChange={(patch) => setGrpc((value) => ({ ...value, ...patch }))}
    schema={{ status: 'idle' }} onLoad={vi.fn()} rootPath="/ws" />
}

describe('GrpcSchemaControls', () => {
  it('changes the schema source in the bar and restores focus when closing with Escape', () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Origem dos serviços' })
    expect(trigger).toHaveTextContent('Reflection')
    fireEvent.click(trigger)
    const popup = screen.getByRole('dialog', { name: 'Origem dos serviços' })
    expect(within(popup).getByRole('radio', { name: 'Reflection do servidor' })).toHaveFocus()
    fireEvent.click(within(popup).getByRole('radio', { name: 'Arquivos .proto' }))
    expect(trigger).toHaveTextContent('Arquivos .proto')
    expect(within(popup).getByRole('button', { name: 'Adicionar arquivos .proto' })).toBeInTheDocument()
    fireEvent.keyDown(popup, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('forces service refresh from the bar and disables it while loading', () => {
    const onLoad = vi.fn()
    const props = { grpc: emptyGrpcCall, onChange: vi.fn(), onLoad, rootPath: '/ws' }
    const { rerender } = render(<GrpcSchemaControls {...props} schema={{ status: 'idle' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar serviços' }))
    expect(onLoad).toHaveBeenCalledWith(true)
    rerender(<GrpcSchemaControls {...props} schema={{ status: 'loading' }} />)
    expect(screen.getByRole('button', { name: 'Recarregar serviços' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Recarregar serviços' })).toHaveAttribute('aria-busy', 'true')
  })

  it('closes on an outside click and locks schema changes while disabled', () => {
    const props = { grpc: emptyGrpcCall, onChange: vi.fn(), onLoad: vi.fn(), rootPath: '/ws' }
    const { rerender } = render(<GrpcSchemaControls {...props} schema={{ status: 'idle' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Origem dos serviços' }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Origem dos serviços' }))
    rerender(<GrpcSchemaControls {...props} schema={{ status: 'idle' }} disabled />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Origem dos serviços' })).toBeDisabled()
  })
})
