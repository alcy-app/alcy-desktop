import { describe, expect, it } from 'vitest'
import { emptyAuthorizationState } from '../authorization-state'
import { emptyBodyState } from '../body-state'
import type { AuthorizationState, BodyState, HeaderEntry } from '../request-workbench.types'
import { SNIPPET_LANGUAGES, generateSnippet } from './generators'
import { buildSnippetRequest, type SnippetRequest } from './snippet-request'

type Tab = Parameters<typeof buildSnippetRequest>[0]

const variables = [
  { name: 'baseUrl', value: 'https://api.test', sensitive: false },
  { name: 'token', value: 'secret', sensitive: true },
]

function header(name: string, value: string, enabled = true): HeaderEntry {
  return { id: name, name, value, enabled }
}

function restTab(overrides: Partial<Tab> = {}): Tab {
  return {
    protocol: 'rest',
    method: 'get',
    endpointUrl: '{{baseUrl}}/users',
    query: '',
    variables: '',
    headers: [],
    routeParams: [],
    body: { ...emptyBodyState, type: 'none' },
    authorization: { ...emptyAuthorizationState },
    ...overrides,
  }
}

function body(overrides: Partial<BodyState>): BodyState {
  return { ...emptyBodyState, ...overrides }
}

function auth(overrides: Partial<AuthorizationState>): AuthorizationState {
  return { ...emptyAuthorizationState, ...overrides }
}

describe('buildSnippetRequest', () => {
  it('resolves environment variables but keeps sensitive ones as placeholders', () => {
    const request = buildSnippetRequest(
      restTab({ authorization: auth({ type: 'bearer', token: '{{token}}' }) }),
      undefined,
      variables,
    )
    expect(request.url).toBe('https://api.test/users')
    expect(request.headers).toEqual([{ name: 'Authorization', value: 'Bearer {{token}}' }])
  })

  it('uses the authentication value instead of a manual Authorization header', () => {
    const request = buildSnippetRequest(
      restTab({
        headers: [header('authorization', 'Bearer manual-token')],
        authorization: auth({ type: 'bearer', token: 'configured-token' }),
      }),
      undefined,
      [],
    )

    expect(request.headers).toEqual([{ name: 'Authorization', value: 'Bearer configured-token' }])
  })

  it('uses a custom authentication header instead of a manual header with the same name', () => {
    const request = buildSnippetRequest(
      restTab({
        headers: [header('X-Api-Key', 'manual-key')],
        authorization: auth({ type: 'customHeader', headerName: 'x-api-key', headerValue: 'configured-key' }),
      }),
      undefined,
      [],
    )

    expect(request.headers).toEqual([{ name: 'x-api-key', value: 'configured-key' }])
  })

  it('resolves route params and preserves sensitive values as placeholders', () => {
    const request = buildSnippetRequest(
      restTab({
        endpointUrl: '{{baseUrl}}/users/:userId/:token',
        routeParams: [
          { id: 'route-user', name: 'userId', value: '42' },
          { id: 'route-token', name: 'token', value: '{{token}}' },
        ],
      }),
      undefined,
      variables,
    )

    expect(request.url).toBe('https://api.test/users/42/{{token}}')
  })

  it('keeps only enabled headers with a name', () => {
    const request = buildSnippetRequest(
      restTab({ headers: [header('Accept', 'application/json'), header('X-Off', '1', false), header(' ', 'x')] }),
      undefined,
      [],
    )
    expect(request.headers).toEqual([{ name: 'Accept', value: 'application/json' }])
  })

  it('builds the GraphQL JSON body and adds Content-Type', () => {
    const request = buildSnippetRequest(
      restTab({ protocol: 'graphql', query: 'query { me { id } }', variables: '{"id": 1}' }),
      undefined,
      [],
    )
    expect(request.method).toBe('POST')
    expect(request.body).toEqual({
      type: 'text',
      text: JSON.stringify({ query: 'query { me { id } }', variables: { id: 1 } }, null, 2),
    })
    expect(request.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })
  })

  it('encodes basic credentials unless a placeholder remains', () => {
    const encoded = buildSnippetRequest(restTab({ authorization: auth({ type: 'basic', username: 'ana', password: 'pá' }) }), undefined, [])
    expect(encoded.headers).toEqual([{ name: 'Authorization', value: 'Basic YW5hOnDDoQ==' }])

    const placeholder = buildSnippetRequest(
      restTab({ authorization: auth({ type: 'basic', username: 'ana', password: '{{token}}' }) }),
      undefined,
      variables,
    )
    expect(placeholder.headers).toEqual([{ name: 'Authorization', value: 'Basic ana:{{token}}' }])
  })

  it('uses the inherited authentication when the tab inherits', () => {
    const request = buildSnippetRequest(restTab({ authorization: auth({ type: 'inherit' }) }), { type: 'bearer', token: 'abc' }, [])
    expect(request.headers).toEqual([{ name: 'Authorization', value: 'Bearer abc' }])
  })

  it('drops a fixed multipart Content-Type so the client can set the boundary', () => {
    const request = buildSnippetRequest(
      restTab({
        method: 'post',
        headers: [header('Content-Type', 'multipart/form-data')],
        body: body({
          type: 'formData',
          formData: [{ id: '1', name: 'file', enabled: true, kind: 'file', value: '', filePath: 'data/a.png' }],
        }),
      }),
      undefined,
      [],
    )
    expect(request.headers).toEqual([])
    expect(request.body).toEqual({ type: 'formData', fields: [{ kind: 'file', name: 'file', path: 'data/a.png' }] })
  })

  it('turns OAuth 2.0 into a token placeholder with a note', () => {
    const request = buildSnippetRequest(
      restTab({ authorization: auth({ type: 'oauth2ClientCredentials', tokenUrl: 'https://auth.test/token' }) }),
      undefined,
      [],
    )
    expect(request.headers).toEqual([{ name: 'Authorization', value: 'Bearer <access_token>' }])
    expect(request.notes[0]).toContain('https://auth.test/token')
  })
})

const jsonPost: SnippetRequest = {
  method: 'POST',
  url: 'https://api.test/users',
  headers: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Authorization', value: 'Bearer {{token}}' },
  ],
  body: { type: 'text', text: '{\n  "name": "O\'Brien",\n  "active": true,\n  "tags": null\n}' },
  digest: null,
  notes: [],
}

const formPost: SnippetRequest = {
  method: 'POST',
  url: 'https://api.test/upload',
  headers: [],
  body: {
    type: 'formData',
    fields: [
      { kind: 'text', name: 'title', value: 'Report' },
      { kind: 'file', name: 'file', path: 'files/report.pdf' },
    ],
  },
  digest: null,
  notes: [],
}

describe('generateSnippet', () => {
  it('lists cURL and wget first', () => {
    expect(SNIPPET_LANGUAGES.slice(0, 2).map((language) => language.id)).toEqual(['curl', 'wget'])
  })

  it('escapes single quotes for the shell', () => {
    const code = generateSnippet('curl', jsonPost)
    expect(code).toContain(`--data-raw '{\n  "name": "O'\\''Brien",`)
    expect(generateSnippet('wget', jsonPost)).toContain(`--body-data='{\n  "name": "O'\\''Brien",`)
  })

  it('generates cURL for url-encoded, multipart, binary and digest', () => {
    const urlencoded = generateSnippet('curl', {
      ...jsonPost,
      headers: [],
      body: { type: 'urlencoded', fields: [{ name: 'a b', value: 'c&d' }] },
    })
    expect(urlencoded).toContain(`--data-urlencode 'a%20b=c&d'`)

    const multipart = generateSnippet('curl', formPost)
    expect(multipart).toContain(`--form-string 'title=Report'`)
    expect(multipart).toContain(`--form 'file=@files/report.pdf'`)

    const binary = generateSnippet('curl', { ...formPost, body: { type: 'file', path: 'a.bin' } })
    expect(binary).toContain(`--data-binary '@a.bin'`)

    const digest = generateSnippet('curl', { ...formPost, body: { type: 'none' }, digest: { username: 'u', password: 'p' } })
    expect(digest).toContain(`--digest \\\n  --user 'u:p'`)
  })

  it('explains features a language cannot generate', () => {
    expect(generateSnippet('wget', formPost)).toContain('# wget does not support multipart/form-data')
    expect(generateSnippet('go', { ...jsonPost, digest: { username: 'u', password: 'p' } })).toContain(
      '// Digest authentication (user "u")',
    )
  })

  it('keeps notes as comments', () => {
    const code = generateSnippet('python-requests', { ...jsonPost, notes: ['Replace the token.'] })
    expect(code.startsWith('# Replace the token.\n')).toBe(true)
  })

  it('escapes interpolation markers in Kotlin and Ruby strings', () => {
    const request = { ...jsonPost, headers: [{ name: 'X-Price', value: '$5 #{x}' }] }
    expect(generateSnippet('kotlin', request)).toContain('"\\$5 #{x}"')
    expect(generateSnippet('ruby', request)).toContain('"$5 \\#{x}"')
  })

  it.each(SNIPPET_LANGUAGES.map((language) => language.id))('generates %s for a JSON POST', (language) => {
    expect(generateSnippet(language, jsonPost)).toMatchSnapshot()
  })

  it.each(SNIPPET_LANGUAGES.map((language) => language.id))('generates %s for a multipart POST', (language) => {
    expect(generateSnippet(language, formPost)).toMatchSnapshot()
  })
})
