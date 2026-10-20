import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { LANGUAGE_STORAGE_KEY } from '../../shared/i18n/translations'
import { FlowMappingProvider } from './flow-mapping'
import { FlowTemplateTextarea } from './FlowTemplateTextarea'

function Editable({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return <div data-flow-fields><FlowTemplateTextarea mono aria-label="Template" value={value} onChange={(event) => setValue(event.target.value)} /></div>
}

beforeEach(() => localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en'))

describe('flow textarea variable highlighting', () => {
  it('marks known variables and node paths, distinguishes missing names, and leaves unfinished tokens literal', () => {
    const value = 'Token: {{ token }}\n{{nodes.login.response.body.users.0.id}} / {{missing}}\n{{unfinished'
    const { container } = render(<LanguageProvider><FlowMappingProvider references={['{{token}}', '{{nodes.login.response.body}}']}><Editable initial={value} /></FlowMappingProvider></LanguageProvider>)
    expect(screen.getByRole('textbox', { name: 'Template' })).toHaveValue(value)
    expect([...container.querySelectorAll('.var-token--known')].map((token) => token.textContent)).toEqual(['{{ token }}', '{{nodes.login.response.body.users.0.id}}'])
    expect(container.querySelector('.var-token--unknown')).toHaveTextContent('{{missing}}')
    expect(container.querySelectorAll('.var-token')).toHaveLength(3)
    expect(container.querySelector('.flow-template-overlay')).toHaveAttribute('aria-hidden', 'true')
  })

  it('updates highlights when available variables change without replacing text, focus or selection', () => {
    const renderField = (references: string[]) => <LanguageProvider><FlowMappingProvider references={references}><Editable initial="Hello {{name}}" /></FlowMappingProvider></LanguageProvider>
    const { container, rerender } = render(renderField([]))
    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    act(() => { field.focus(); field.setSelectionRange(7, 10) })
    expect(container.querySelector('.var-token--unknown')).toHaveTextContent('{{name}}')
    rerender(renderField(['{{name}}']))
    expect(container.querySelector('.var-token--unknown')).toBeNull()
    expect(container.querySelector('.var-token--known')).toHaveTextContent('{{name}}')
    expect(field).toHaveValue('Hello {{name}}')
    expect(field).toHaveFocus()
    expect([field.selectionStart, field.selectionEnd]).toEqual([7, 10])
    fireEvent.change(field, { target: { value: 'Hello {{name}}\nsecond line' } })
    expect(field).toHaveValue('Hello {{name}}\nsecond line')
    expect(container.querySelector('.flow-template-overlay')).toHaveTextContent('second line')
  })

  it('keeps scrolling and resizing aligned with the native textarea', () => {
    let resize = () => undefined
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => undefined) { resize = callback }
      observe() {}
      disconnect = disconnect
    })
    try {
      const { container, unmount } = render(<LanguageProvider><FlowMappingProvider><Editable initial={'line\n'.repeat(30)} /></FlowMappingProvider></LanguageProvider>)
      const field = screen.getByRole('textbox') as HTMLTextAreaElement
      const overlay = container.querySelector<HTMLElement>('.flow-template-overlay')!
      Object.defineProperties(field, { clientWidth: { configurable: true, value: 300 }, clientHeight: { configurable: true, value: 100 } })
      fireEvent.scroll(field, { target: { scrollTop: 50, scrollLeft: 12 } })
      expect([overlay.scrollTop, overlay.scrollLeft]).toEqual([50, 12])
      expect([overlay.style.width, overlay.style.height]).toEqual(['300px', '100px'])
      Object.defineProperty(field, 'clientHeight', { configurable: true, value: 180 })
      act(() => resize())
      expect(overlay.style.height).toBe('180px')
      unmount()
      expect(disconnect).toHaveBeenCalledOnce()
    } finally { vi.unstubAllGlobals() }
  })

  it('highlights a reference inserted by the flow autocomplete and preserves the caret', async () => {
    const { container } = render(<LanguageProvider><FlowMappingProvider references={['{{token}}']}><Editable initial="Bearer {{tok" /></FlowMappingProvider></LanguageProvider>)
    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    act(() => { field.focus(); field.setSelectionRange(field.value.length, field.value.length) })
    const option = await screen.findByRole('option', { name: '{{token}}' })
    fireEvent.mouseDown(option)
    expect(field).toHaveValue('Bearer {{token}}')
    expect(container.querySelector('.var-token--known')).toHaveTextContent('{{token}}')
    expect(field).toHaveFocus()
    expect(field.selectionStart).toBe('Bearer {{token}}'.length)
  })
})
