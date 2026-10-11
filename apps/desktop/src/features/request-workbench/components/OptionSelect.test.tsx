import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { OptionSelect } from './OptionSelect'

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
]

function Harness() {
  const [value, setValue] = useState('a')
  return <OptionSelect id="sel" value={value} options={options} onChange={setValue} />
}

describe('OptionSelect', () => {
  it('abre a lista, marca a opção atual e seleciona ao clicar', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox')
    expect(trigger).toHaveTextContent('Alpha')

    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveTextContent('Beta')
  })

  it('navega por teclado e fecha com Escape sem alterar o valor', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox')

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger).toHaveTextContent('Beta')

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'End' })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveTextContent('Beta')
  })

  it('continua aberta ao rolar a própria lista e fecha ao rolar a página', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox'))

    fireEvent.scroll(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.scroll(document)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
