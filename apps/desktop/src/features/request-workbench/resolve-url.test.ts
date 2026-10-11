import { describe, expect, it } from 'vitest'
import { resolveTemplateForDisplay } from './resolve-url'

const variables = [
  { name: 'baseUrl', value: 'https://api.test', sensitive: false },
  { name: 'token', value: 'secret', sensitive: true },
]

describe('resolveTemplateForDisplay', () => {
  it('replaces environment variables', () => {
    expect(resolveTemplateForDisplay('{{baseUrl}}/users/{{ baseUrl }}', variables)).toBe(
      'https://api.test/users/https://api.test',
    )
  })

  it('keeps sensitive and unknown variables as placeholders', () => {
    expect(resolveTemplateForDisplay('/a?t={{token}}&x={{nope}}', variables)).toBe('/a?t={{token}}&x={{nope}}')
  })
})
