import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '../../test-utils'
import type { AgentModelDto } from '../../bindings/agent-settings'
import { ModelCombobox } from './ModelCombobox'

const models: AgentModelDto[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'kimi-k2.6', label: 'kimi-k2.6' },
]

function Harness({ initial = '', list = models, onLoad = vi.fn(), canLoad = true }: { initial?: string; list?: AgentModelDto[]; onLoad?: () => void; canLoad?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <ModelCombobox value={value} onChange={setValue} models={list} loading={false} canLoad={canLoad} onLoad={onLoad} label="Modelo" placeholder="Escolha" />
      <output>{value}</output>
    </>
  )
}

describe('ModelCombobox', () => {
  it('offers to load the models when none are loaded', () => {
    const onLoad = vi.fn()
    render(<Harness list={[]} onLoad={onLoad} />)
    fireEvent.focus(screen.getByRole('combobox', { name: 'Modelo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Carregar modelos' }))
    expect(onLoad).toHaveBeenCalled()
  })

  it('asks to save before loading when there are unsaved edits', () => {
    render(<Harness list={[]} canLoad={false} />)
    fireEvent.focus(screen.getByRole('combobox', { name: 'Modelo' }))
    expect(screen.getByText('Salve as alterações para carregar os modelos.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Carregar modelos' })).not.toBeInTheDocument()
  })

  it('filters while typing and picks with the keyboard', () => {
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Modelo' })
    fireEvent.focus(input)
    expect(screen.getAllByRole('option')).toHaveLength(3)

    fireEvent.change(input, { target: { value: 'opus' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.querySelector('output')).toHaveTextContent('claude-opus-5-5')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('keeps free text when nothing matches and picks with the mouse', () => {
    render(<Harness initial="kimi-k2.6" />)
    const input = screen.getByRole('combobox', { name: 'Modelo' })
    fireEvent.focus(input)
    expect(screen.getByRole('option', { name: /kimi-k2\.6/ })).toHaveAttribute('data-selected', 'true')

    fireEvent.change(input, { target: { value: 'my-local-model' } })
    expect(screen.getByText(/Nenhum modelo com esse nome/)).toBeInTheDocument()
    expect(document.querySelector('output')).toHaveTextContent('my-local-model')

    fireEvent.change(input, { target: { value: 'sonnet' } })
    fireEvent.click(screen.getByRole('option', { name: /claude-sonnet-5-5/ }))
    expect(document.querySelector('output')).toHaveTextContent('claude-sonnet-5-5')
  })
})
