import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Input } from './Input'

describe('Input', () => {
  it('turns off the webview suggestions of values typed before, unless asked for', () => {
    render(
      <>
        <Input aria-label="Commit message" />
        <Input aria-label="Password" type="password" autoComplete="current-password" />
      </>,
    )

    expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
  })
})
