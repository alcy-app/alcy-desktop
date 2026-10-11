import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { translate } from '../../../shared/i18n/translations'
import { fireEvent, render, screen } from '../../../test-utils'
import { MAX_PREVIEW_CHARS } from '../variable-preview'
import { VariablePreviewCard } from './VariablePreviewCard'

const VARIABLES: EnvironmentVariableDto[] = [
  { name: 'token', value: 'abc123', sensitive: false },
  { name: 'secret', value: 's3cr3t', sensitive: true },
  { name: 'blank', value: '', sensitive: false },
  { name: 'long', value: 'x'.repeat(MAX_PREVIEW_CHARS + 10), sensitive: false },
]

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('pt-BR', key, params)

function renderCard(name: string, props: Partial<Parameters<typeof VariablePreviewCard>[0]> = {}) {
  return render(<VariablePreviewCard name={name} variables={VARIABLES} t={t} onSetValue={null} {...props} />)
}

describe('VariablePreviewCard — só leitura (sem ambiente ativo)', () => {
  it('mostra nome, selo e valor de uma variável definida', () => {
    const { container } = renderCard('token')
    expect(container.querySelector('.var-preview')).toHaveClass('var-preview--defined')
    expect(container.querySelector('.var-preview-name')).toHaveTextContent('token')
    expect(container.querySelector('.var-preview-badge')).toHaveTextContent('Definida')
    expect(screen.getByText('abc123')).toHaveClass('var-preview-value')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('nunca inclui o valor de uma variável sensível ou em campo mascarado', () => {
    const { container, unmount } = renderCard('secret')
    expect(container).not.toHaveTextContent('s3cr3t')
    expect(screen.getByText('Valor sensível, não exibido.')).toBeInTheDocument()
    unmount()

    const hidden = renderCard('token', { hideValue: true })
    expect(hidden.container).not.toHaveTextContent('abc123')
    expect(hidden.container.querySelector('.var-preview-badge')).toHaveTextContent('Oculta')
  })

  it('explica uma variável indefinida, sem oferecer criação', () => {
    const { container } = renderCard('nope')
    expect(container.querySelector('.var-preview-badge')).toHaveTextContent('Indefinida')
    expect(screen.getByText('Não existe no ambiente ativo nem na coleção.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('indica valor vazio e reticências em valor cortado', () => {
    renderCard('blank')
    expect(screen.getByText('(vazio)')).toHaveClass('var-preview-empty')
    const { container } = renderCard('long')
    expect(container.querySelector('.var-preview-value')?.textContent?.endsWith('…')).toBe(true)
  })
})

describe('VariablePreviewCard — edição (com ambiente ativo)', () => {
  it('edita o valor, gravando a cada alteração', () => {
    const onSetValue = vi.fn()
    renderCard('token', { onSetValue })
    const input = screen.getByLabelText('Valor da variável token')
    expect(input).toHaveValue('abc123')
    expect(input).toHaveAttribute('type', 'text')
    expect(input).not.toHaveFocus()

    fireEvent.change(input, { target: { value: 'novo' } })
    expect(onSetValue).toHaveBeenLastCalledWith('token', 'novo')
    expect(input).toHaveValue('novo')
  })

  it('edita valores sensíveis e de campos mascarados num campo de senha', () => {
    renderCard('secret', { onSetValue: vi.fn() })
    expect(screen.getByLabelText('Valor da variável secret')).toHaveAttribute('type', 'password')
  })

  it('cria uma variável indefinida no ambiente ativo', () => {
    const onSetValue = vi.fn()
    renderCard('nova', { onSetValue })

    fireEvent.click(screen.getByRole('button', { name: 'Criar no ambiente ativo' }))
    expect(onSetValue).toHaveBeenCalledWith('nova', '')

    const input = screen.getByLabelText('Valor da variável nova')
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'valor' } })
    expect(onSetValue).toHaveBeenLastCalledWith('nova', 'valor')
  })

  it('fecha com Enter ou Esc', () => {
    const onRequestClose = vi.fn()
    renderCard('token', { onSetValue: vi.fn(), onRequestClose })
    const input = screen.getByLabelText('Valor da variável token')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRequestClose).toHaveBeenCalledTimes(2)
  })
})

describe('VariablePreviewCard — variáveis de coleção e pasta', () => {
  const source = { nodeId: 'f1', kind: 'folder' as const, name: 'Pedidos' }
  const scoped = [{ name: 'orderId', value: '42', sensitive: false, source }]

  it('mostra a origem e grava no escopo que define a variável', () => {
    const onSetValue = vi.fn()
    render(<VariablePreviewCard name="orderId" variables={scoped} t={t} onSetValue={onSetValue} />)

    expect(screen.getByText('Da pasta Pedidos')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Valor da variável orderId'), { target: { value: '7' } })
    expect(onSetValue).toHaveBeenLastCalledWith('orderId', '7', source)
  })

  it('sem ambiente ativo, não oferece criar uma variável indefinida', () => {
    renderCard('nova', { onSetValue: vi.fn(), canCreate: false })

    expect(screen.queryByRole('button', { name: 'Criar no ambiente ativo' })).not.toBeInTheDocument()
  })
})
