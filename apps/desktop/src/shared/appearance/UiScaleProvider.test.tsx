import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ICON_SCALE_STORAGE_KEY, MAX_UI_SCALE, TEXT_SCALE_STORAGE_KEY } from './ui-scale'
import { UiScaleProvider } from './UiScaleProvider'
import { useUiScale } from './use-ui-scale'

function Probe() {
  const { textScale, iconScale, setTextScale, setIconScale } = useUiScale()
  return (
    <>
      <button onClick={() => setTextScale(1.1)}>text:{textScale}</button>
      <button onClick={() => setIconScale(1.2)}>icon:{iconScale}</button>
      <button onClick={() => setIconScale(5)}>overflow</button>
    </>
  )
}

const rootStyle = () => document.documentElement.style

describe('UiScaleProvider', () => {
  it('usa 100% para texto e ícones por padrão e aplica no documento', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>)
    expect(screen.getByText('text:1')).toBeInTheDocument()
    expect(screen.getByText('icon:1')).toBeInTheDocument()
    expect(rootStyle().getPropertyValue('--text-scale')).toBe('1')
    expect(rootStyle().getPropertyValue('--icon-scale')).toBe('1')
  })

  it('mantém a escala salva pela versão anterior como escala de texto', () => {
    window.localStorage.setItem(TEXT_SCALE_STORAGE_KEY, '1.15')
    render(<UiScaleProvider><Probe /></UiScaleProvider>)
    expect(screen.getByText('text:1.15')).toBeInTheDocument()
    expect(screen.getByText('icon:1')).toBeInTheDocument()
  })

  it('ignora valor salvo inválido', () => {
    window.localStorage.setItem(ICON_SCALE_STORAGE_KEY, 'abc')
    window.localStorage.setItem(TEXT_SCALE_STORAGE_KEY, '4')
    render(<UiScaleProvider><Probe /></UiScaleProvider>)
    expect(screen.getByText('text:1')).toBeInTheDocument()
    expect(screen.getByText('icon:1')).toBeInTheDocument()
  })

  it('altera e persiste cada escala de forma independente', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>)
    fireEvent.click(screen.getByText('icon:1'))
    expect(screen.getByText('text:1')).toBeInTheDocument()
    expect(rootStyle().getPropertyValue('--icon-scale')).toBe('1.2')
    expect(window.localStorage.getItem(ICON_SCALE_STORAGE_KEY)).toBe('1.2')
    fireEvent.click(screen.getByText('text:1'))
    expect(rootStyle().getPropertyValue('--text-scale')).toBe('1.1')
    expect(window.localStorage.getItem(TEXT_SCALE_STORAGE_KEY)).toBe('1.1')
  })

  it('limita a escala à faixa permitida', () => {
    render(<UiScaleProvider><Probe /></UiScaleProvider>)
    fireEvent.click(screen.getByText('overflow'))
    expect(screen.getByText(`icon:${MAX_UI_SCALE}`)).toBeInTheDocument()
  })
})
