import { describe, expect, it } from 'vitest'
import type { SessionCookieDto } from '../../bindings/session-cookies'
import { cookieHeaderValue, cookiesFor } from './session-cookies'

const cookie = (overrides: Partial<SessionCookieDto>): SessionCookieDto => ({
  name: 'sid',
  value: '1',
  domain: 'api.test',
  hostOnly: true,
  path: '/',
  secure: false,
  expiresAtMs: null,
  ...overrides,
})

describe('cookiesFor', () => {
  it('respeita host exato, domínio e subdomínios', () => {
    const cookies = [cookie({ name: 'a' }), cookie({ name: 'b', hostOnly: false, domain: 'test' })]
    expect(cookiesFor(cookies, 'https://api.test/x').map((c) => c.name)).toEqual(['a', 'b'])
    expect(cookiesFor(cookies, 'https://other.test/x').map((c) => c.name)).toEqual(['b'])
    expect(cookiesFor(cookies, 'https://elsewhere.com/')).toEqual([])
  })

  it('respeita path, Secure e expiração', () => {
    const cookies = [
      cookie({ name: 'admin', path: '/admin' }),
      cookie({ name: 'seguro', secure: true }),
      cookie({ name: 'velho', expiresAtMs: 10 }),
    ]
    expect(cookiesFor(cookies, 'https://api.test/admin/x', 100).map((c) => c.name)).toEqual(['admin', 'seguro'])
    expect(cookiesFor(cookies, 'http://api.test/administrator', 100)).toEqual([])
  })

  it('ignora URL inválida', () => {
    expect(cookiesFor([cookie({})], '{{baseUrl}}/x')).toEqual([])
  })

  it('monta o valor do header', () => {
    expect(cookieHeaderValue([cookie({}), cookie({ name: 'b', value: '2' })])).toBe('sid=1; b=2')
  })
})
