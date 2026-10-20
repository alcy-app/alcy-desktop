import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { IconButton } from './IconButton'
import { MenuItem, OptionsMenu } from './Menu'
import { OverlayMotionContext } from './overlay-motion-context'
import { TOOLTIP_DELAY_MS } from './use-tooltip'

afterEach(() => vi.useRealTimers())

describe('overlay motion scope', () => {
  it('keeps canvas hover hints static across portals while other controls retain their default motion', () => {
    vi.useFakeTimers()
    const { container } = render(<>
      <OverlayMotionContext value={false}><IconButton icon={<span />} label="Canvas control" /></OverlayMotionContext>
      <IconButton icon={<span />} label="Sidebar control" />
    </>)
    const canvas = screen.getByRole('button', { name: 'Canvas control' })
    fireEvent.mouseEnter(canvas)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    const hint = screen.getByRole('tooltip')
    expect(hint).toHaveTextContent('Canvas control')
    expect(hint).toHaveClass('ui-tooltip--static')
    expect(hint.parentElement).toBe(document.body)
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
    fireEvent.mouseLeave(canvas)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Sidebar control' }))
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS))
    expect(screen.getByRole('tooltip')).not.toHaveClass('ui-tooltip--static')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps canvas menu actions static and functional without changing menus outside that scope', () => {
    const duplicate = vi.fn()
    const close = vi.fn()
    render(<>
      <OverlayMotionContext value={false}>
        <OptionsMenu label="Canvas actions" isOpen menuPortal onToggle={() => {}} onClose={close}>
          <MenuItem label="Duplicate" onSelect={duplicate} />
        </OptionsMenu>
      </OverlayMotionContext>
      <OptionsMenu label="Sidebar actions" isOpen menuPortal onToggle={() => {}} onClose={() => {}}>
        <MenuItem label="Rename" onSelect={() => {}} />
      </OptionsMenu>
    </>)
    const menu = screen.getByRole('menu', { name: 'Canvas actions' })
    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveClass('ui-menu--static')
    expect(screen.getByRole('menu', { name: 'Sidebar actions' })).not.toHaveClass('ui-menu--static')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))
    expect(duplicate).toHaveBeenCalledOnce()
    close.mockClear()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Canvas actions' })).toHaveFocus()
  })
})
