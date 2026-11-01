import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { fireEvent, render, screen } from '../../../test-utils'
import { installButtonMousedownWorkaround } from '../../../shared/button-mousedown-workaround'
import type { FieldSuggestion } from '../schema-completions'
import { TemplateHighlightedField } from './TemplateHighlightedField'

const VARIABLES: EnvironmentVariableDto[] = [
  { name: 'token', value: 'abc123', sensitive: false },
  { name: 'secret', value: 's3cr3t', sensitive: true },
]

function Field({ initial = '', masked = false }: { initial?: string; masked?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <label htmlFor="field">Campo</label>
      <TemplateHighlightedField
        id="field"
        fieldClassName="ui-input"
        value={value}
        onChange={setValue}
        variables={VARIABLES}
        masked={masked}
      />
    </>
  )
}

const DOC_SUGGESTIONS: FieldSuggestion[] = [
  { value: 'status', detail: 'string *', description: 'Filtra por status' },
  { value: 'page', detail: 'integer' },
]

function RouteField() {
  const [value, setValue] = useState('https://api.test:8443/users/:userId?next=/:ignored')
  return (
    <>
      <label htmlFor="route-field">URL</label>
      <TemplateHighlightedField
        id="route-field"
        fieldClassName="ui-input"
        value={value}
        onChange={setValue}
        variables={VARIABLES}
        highlightRouteParams
      />
    </>
  )
}

function SuggestedField({ templates = true }: { templates?: boolean }) {
  const [value, setValue] = useState('')
  return (
    <>
      <label htmlFor="suggested">Nome</label>
      <TemplateHighlightedField
        id="suggested"
        fieldClassName="ui-input"
        value={value}
        onChange={setValue}
        variables={VARIABLES}
        suggestions={DOC_SUGGESTIONS}
        templates={templates}
      />
    </>
  )
}

describe('TemplateHighlightedField', () => {
  it('sugere variáveis ao digitar {{ e insere o nome com o fechamento', () => {
    render(<Field />)
    const input = screen.getByLabelText('Campo')

    fireEvent.change(input, { target: { value: 'Bearer {{' } })
    const suggestions = screen.getByRole('listbox', { name: 'Sugestões de variáveis' })
    expect(suggestions).toHaveTextContent('token')
    expect(suggestions).toHaveTextContent('secret')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('Bearer {{token}}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('aceita a sugestão destacada com Tab, sem mover o foco', () => {
    render(<Field />)
    const input = screen.getByLabelText('Campo')
    input.focus()

    fireEvent.change(input, { target: { value: '{{' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const tab = fireEvent.keyDown(input, { key: 'Tab' })

    expect(tab).toBe(false)
    expect(input).toHaveValue('{{secret}}')
    expect(input).toHaveFocus()
  })

  it('aceita a sugestão ao clicar nela, mesmo com o contorno global de mousedown do app', () => {
    // Instalado em `main.tsx`: dá foco a qualquer botão no mousedown (captura),
    // o que antes tirava o foco do input e fechava a lista antes do clique.
    const uninstall = installButtonMousedownWorkaround()
    try {
      render(<Field />)
      const input = screen.getByLabelText('Campo')
      input.focus()

      fireEvent.change(input, { target: { value: 'x {{to' } })
      fireEvent.mouseDown(screen.getByRole('option', { name: 'token' }))

      expect(input).toHaveValue('x {{token}}')
      expect(input).toHaveFocus()
    } finally {
      uninstall()
    }
  })

  it('destaca route params no caminho sem destacar porta ou query string', () => {
    render(<RouteField />)

    expect([...document.querySelectorAll('.route-param-token')].map((token) => token.textContent)).toEqual([':userId'])
    expect(screen.getByLabelText('URL')).toHaveValue('https://api.test:8443/users/:userId?next=/:ignored')
  })

  it('deixa Tab mover o foco quando não há sugestões abertas', () => {
    render(<Field initial="texto" />)
    expect(fireEvent.keyDown(screen.getByLabelText('Campo'), { key: 'Tab' })).toBe(true)
  })

  it('mostra o valor da variável no tooltip', () => {
    render(<Field initial="{{token}}" />)
    const token = document.querySelector('.var-token--known') as Element
    fireEvent.mouseEnter(token)
    expect(screen.getByText('abc123')).toHaveClass('var-preview-value')
    expect(document.querySelector('.var-preview-badge')).toHaveTextContent('Definida')
  })

  it('abre o tooltip abaixo do token quando não cabe acima', () => {
    // Token perto do topo da janela e cartão mais alto que o espaço acima:
    // medido só depois de montado, então o lado é decidido em layout effect.
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 10,
      bottom: 24,
      left: 20,
      right: 90,
      width: 70,
      height: 14,
      x: 20,
      y: 10,
      toJSON: () => ({}),
    })
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)

    try {
      render(<Field initial="{{token}}" />)
      fireEvent.mouseEnter(document.querySelector('.var-token--known') as Element)
      const tooltip = document.querySelector('.var-tooltip') as HTMLElement
      expect(tooltip.style.top).toBe('30px')
      expect(tooltip.style.bottom).toBe('')
    } finally {
      rectSpy.mockRestore()
      heightSpy.mockRestore()
    }
  })

  it('mantém o tooltip acima do token quando há espaço', () => {
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 400,
      bottom: 414,
      left: 20,
      right: 90,
      width: 70,
      height: 14,
      x: 20,
      y: 400,
      toJSON: () => ({}),
    })
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)

    try {
      render(<Field initial="{{token}}" />)
      fireEvent.mouseEnter(document.querySelector('.var-token--known') as Element)
      const tooltip = document.querySelector('.var-tooltip') as HTMLElement
      expect(tooltip.style.bottom).toBe(`${window.innerHeight - 400 + 6}px`)
      expect(tooltip.style.top).toBe('')
    } finally {
      rectSpy.mockRestore()
      heightSpy.mockRestore()
    }
  })

  describe('mascarado', () => {
    it('cobre o texto digitado e destaca a variável com cor própria', () => {
      render(<Field initial="pre{{token}}{{nope}}" masked />)
      expect(document.querySelector('.var-masked-text')).toHaveTextContent('pre')
      expect(document.querySelector('.var-token--masked')).toHaveTextContent('{{token}}')
      expect(document.querySelector('.var-token--unknown')).toHaveTextContent('{{nope}}')
      expect(document.querySelector('.var-token--known')).not.toBeInTheDocument()
    })

    it('não revela o valor da variável no tooltip', () => {
      render(<Field initial="{{token}}" masked />)
      fireEvent.mouseEnter(document.querySelector('.var-token--masked') as Element)
      expect(screen.getByText('Valor oculto neste campo.')).toBeInTheDocument()
      expect(document.querySelector('.var-preview-badge')).toHaveTextContent('Oculta')
      expect(screen.queryByText(/abc123/)).not.toBeInTheDocument()
    })

    it('continua sugerindo variáveis', () => {
      render(<Field masked />)
      fireEvent.change(screen.getByLabelText('Campo'), { target: { value: '{{se' } })
      expect(screen.getByRole('listbox', { name: 'Sugestões de variáveis' })).toHaveTextContent('secret')
    })

    it('bloqueia copiar e recortar', () => {
      render(<Field initial="senha" masked />)
      const input = screen.getByLabelText('Campo')
      expect(fireEvent.copy(input)).toBe(false)
      expect(fireEvent.cut(input)).toBe(false)
    })
  })

  describe('sugestões da documentação', () => {
    it('não abrem só por receber foco, para Tab não aceitar nada por engano', () => {
      render(<SuggestedField />)
      const input = screen.getByLabelText('Nome')
      input.focus()
      fireEvent.focus(input)

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
      expect(input).toHaveValue('')
    })

    it('filtram ao digitar, mostram tipo e descrição e substituem o campo ao aceitar', () => {
      render(<SuggestedField />)
      const input = screen.getByLabelText('Nome')

      fireEvent.change(input, { target: { value: 'sta' } })
      const list = screen.getByRole('listbox', { name: 'Sugestões da documentação' })
      expect(list).toHaveTextContent('status')
      expect(list).toHaveTextContent('string *')
      expect(list).toHaveTextContent('Filtra por status')
      expect(list).not.toHaveTextContent('page')

      fireEvent.keyDown(input, { key: 'Enter' })
      expect(input).toHaveValue('status')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('abrem com a seta para baixo e fecham com Esc', () => {
      render(<SuggestedField />)
      const input = screen.getByLabelText('Nome')

      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(screen.getByRole('listbox', { name: 'Sugestões da documentação' })).toHaveTextContent('page')

      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('dão lugar às sugestões de variável quando há um {{ aberto', () => {
      render(<SuggestedField />)
      const input = screen.getByLabelText('Nome')

      fireEvent.change(input, { target: { value: '{{' } })

      expect(screen.getByRole('listbox', { name: 'Sugestões de variáveis' })).toBeInTheDocument()
      expect(screen.queryByRole('listbox', { name: 'Sugestões da documentação' })).not.toBeInTheDocument()
    })

    it('sem templates, {{ não abre sugestões de variável', () => {
      render(<SuggestedField templates={false} />)
      const input = screen.getByLabelText('Nome')

      fireEvent.change(input, { target: { value: '{{' } })

      expect(screen.queryByRole('listbox', { name: 'Sugestões de variáveis' })).not.toBeInTheDocument()
    })
  })
})
