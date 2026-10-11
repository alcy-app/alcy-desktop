import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../test-utils'
import { MenuItem, OptionsMenu } from './Menu'

const rectangle = (top: number, bottom: number): DOMRect =>
  ({ top, bottom, height: bottom - top } as DOMRect)

describe('OptionsMenu', () => {
  it('abre para cima quando não cabe abaixo do limite rolável', () => {
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
})
