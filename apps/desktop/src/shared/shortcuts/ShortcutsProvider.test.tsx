import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { formatCombo, parseCombo, SHORTCUTS_STORAGE_KEY } from './shortcuts'
import { ShortcutsProvider } from './ShortcutsProvider'
import { useShortcuts } from './use-shortcuts'

const trackUsage = vi.hoisted(() => vi.fn())
vi.mock('../usage-events/track-usage', () => ({ trackUsage }))

function Probe() {
  const { bindings, assignShortcut, removeShortcut, resetAllShortcuts } = useShortcuts()
  return (
    <>
      <output>{bindings.saveRequest.map(formatCombo).join(', ')}</output>
      <button onClick={() => assignShortcut('saveRequest', 1, parseCombo('F4')!)}>adicionar</button>
      <button onClick={() => removeShortcut('saveRequest', 0)}>remover</button>
      <button onClick={resetAllShortcuts}>restaurar</button>
    </>
  )
}

const renderProbe = () => render(<ShortcutsProvider><Probe /></ShortcutsProvider>)

describe('ShortcutsProvider', () => {
  it('começa com os atalhos padrão', () => {
    renderProbe()
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl+S')
  })

  it('persiste as mudanças, inclusive a remoção explícita, entre montagens', () => {
    const first = renderProbe()
    fireEvent.click(screen.getByRole('button', { name: 'adicionar' }))
    fireEvent.click(screen.getByRole('button', { name: 'remover' }))
    expect(screen.getByRole('status')).toHaveTextContent('F4')
    first.unmount()

    const second = renderProbe()
    expect(screen.getByRole('status')).toHaveTextContent(/^F4$/)
    fireEvent.click(screen.getByRole('button', { name: 'remover' }))
    second.unmount()

    renderProbe()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('restaura todos os padrões e limpa o armazenamento', () => {
    renderProbe()
    fireEvent.click(screen.getByRole('button', { name: 'remover' }))
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'restaurar' }))
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl+S')
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBeNull()
  })

  it('reports which action changed, never the keys', () => {
    trackUsage.mockClear()
    renderProbe()
    fireEvent.click(screen.getByRole('button', { name: 'adicionar' }))
    fireEvent.click(screen.getByRole('button', { name: 'remover' }))
    fireEvent.click(screen.getByRole('button', { name: 'restaurar' }))
    expect(trackUsage.mock.calls.map(([event]) => event)).toEqual([
      { name: 'shortcut_changed', action: 'saveRequest', change: 'assigned' },
      { name: 'shortcut_changed', action: 'saveRequest', change: 'removed' },
      { name: 'shortcut_changed', change: 'resetAll' },
    ])
  })
})
