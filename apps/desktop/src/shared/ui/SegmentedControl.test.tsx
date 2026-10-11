import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { SegmentedControl } from './SegmentedControl'

type Format = 'json' | 'xml' | 'html' | 'text'

function Harness({ initial = 'json', disabled }: { initial?: Format; disabled?: Format }) {
  const [value, setValue] = useState<Format>(initial)
  return (
    <SegmentedControl<Format>
      layout="inline"
      size="sm"
      ariaLabel="Formato"
      value={value}
      onChange={setValue}
      options={(['json', 'xml', 'html', 'text'] as const).map((format) => ({
        value: format,
        label: format.toUpperCase(),
        disabled: format === disabled,
      }))}
    />
  )
}

describe('SegmentedControl', () => {
  it('aplica as classes de layout e tamanho', () => {
    render(<Harness />)
    const group = screen.getByRole('radiogroup', { name: 'Formato' })
    expect(group).toHaveClass('ui-segmented', 'ui-segmented--inline', 'ui-segmented--sm')
  })

  it('usa o layout empilhado por padrão', () => {
    render(<SegmentedControl ariaLabel="Idioma" value="pt" onChange={() => {}} options={[{ value: 'pt', label: 'Português' }]} />)
    expect(screen.getByRole('radiogroup', { name: 'Idioma' })).toHaveClass('ui-segmented--stacked')
  })

  it('deixa só a opção marcada na ordem de Tab', () => {
    render(<Harness initial="html" />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0, -1])
  })

  it('move foco e seleção com setas, Home e End', () => {
    render(<Harness />)
    const json = screen.getByRole('radio', { name: 'JSON' })

    fireEvent.keyDown(json, { key: 'ArrowRight' })
    const xml = screen.getByRole('radio', { name: 'XML' })
    expect(xml).toHaveAttribute('aria-checked', 'true')
    expect(xml).toHaveFocus()

    fireEvent.keyDown(xml, { key: 'End' })
    expect(screen.getByRole('radio', { name: 'TEXT' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(screen.getByRole('radio', { name: 'TEXT' }), { key: 'ArrowRight' })
    expect(json).toHaveAttribute('aria-checked', 'true')
    expect(json).toHaveFocus()

    fireEvent.keyDown(json, { key: 'ArrowLeft' })
    expect(screen.getByRole('radio', { name: 'TEXT' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(screen.getByRole('radio', { name: 'TEXT' }), { key: 'Home' })
    expect(json).toHaveAttribute('aria-checked', 'true')
  })

  it('pula opções desabilitadas na navegação por teclado', () => {
    render(<Harness disabled="xml" />)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'JSON' }), { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'HTML' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'XML' })).toHaveAttribute('aria-checked', 'false')
  })

  it('separa rótulo e conteúdo final no nome acessível', () => {
    render(
      <SegmentedControl
        layout="inline"
        ariaLabel="Filtro"
        value="failed"
        onChange={() => {}}
        options={[{ value: 'failed', label: 'Falhas', trailing: <span>2</span> }]}
      />,
    )
    expect(screen.getByRole('radio', { name: 'Falhas 2' })).toBeInTheDocument()
  })
})
