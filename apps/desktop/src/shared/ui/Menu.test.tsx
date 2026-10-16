import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import { MenuItem, OptionsMenu } from './Menu'

const rectangle = (top: number, bottom: number): DOMRect =>
  ({ top, bottom, height: bottom - top } as DOMRect)

describe('OptionsMenu', () => {
  it('opens above when it does not fit below the scroll boundary', () => {
    const getBoundingClientRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('env-sidebar')) return rectangle(100, 500)
      if (this.classList.contains('ui-menu-host')) return rectangle(470, 498)
      if (this.getAttribute('role') === 'menu') return rectangle(0, 200)
      return rectangle(0, 0)
    })

    render(
      <div className="env-sidebar">
        <OptionsMenu
          label="Mais opções"
          isOpen
          onToggle={() => {}}
          onClose={() => {}}
          menuPlacement="auto"
          menuBoundarySelector=".env-sidebar"
        >
          <MenuItem label="Renomear" onSelect={() => {}} />
        </OptionsMenu>
      </div>,
    )

    expect(screen.getByRole('menu')).toHaveClass('ui-menu--top')
    getBoundingClientRect.mockRestore()
  })

  it('renders a portal outside the sidebar and clamps a tall menu to the viewport', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 90, bottom: 118, right: 180,
    } as DOMRect)
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300)
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(140)
    vi.stubGlobal('innerHeight', 240)
    const { container } = render(
      <aside className="env-sidebar">
        <OptionsMenu label="Options" isOpen menuPortal menuPlacement="auto" onToggle={() => {}} onClose={() => {}}>
          <MenuItem label="Rename" onSelect={() => {}} />
        </OptionsMenu>
      </aside>,
    )

    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(menu).toHaveClass('ui-menu--portal')
    expect(menu).toHaveStyle({ top: '8px', left: '40px', maxHeight: '224px' })
    rect.mockRestore()
    height.mockRestore()
    width.mockRestore()
    vi.unstubAllGlobals()
  })

  it('keeps portal actions open on focus and pointerdown, and closes on outside interaction', () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()
    render(
      <OptionsMenu label="Options" isOpen menuPortal onToggle={() => {}} onClose={onClose}>
        <MenuItem label="Rename" onSelect={onSelect} />
      </OptionsMenu>,
    )
    const trigger = screen.getByRole('button', { name: 'Options' })
    const item = screen.getByRole('menuitem')
    expect(item).toHaveFocus()
    fireEvent.blur(trigger, { relatedTarget: item })
    fireEvent.pointerDown(item)
    fireEvent.click(item)
    expect(onClose).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledOnce()

    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('ignores menu scrolling and closes on ancestor scroll, resize, and Escape', () => {
    const onClose = vi.fn()
    render(
      <OptionsMenu label="Options" isOpen menuPortal onToggle={() => {}} onClose={onClose}>
        <MenuItem label="Rename" onSelect={() => {}} />
      </OptionsMenu>,
    )
    const menu = screen.getByRole('menu')
    fireEvent.scroll(menu)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.scroll(document)
    fireEvent.resize(window)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: 'Options' })).toHaveFocus()
  })
})
