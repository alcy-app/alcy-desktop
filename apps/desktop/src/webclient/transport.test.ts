import { describe, expect, it, vi } from 'vitest'
import type { HttpCall } from './build-request'
import { detectServer, execute, send, TransportError } from './transport'

const call: HttpCall = {
  method: 'POST',
  url: 'https://api.test/items',
  headers: [['X-One', '1']],
  body: { kind: 'text', text: 'olá' },
}

const signal = () => new AbortController().signal

describe('send', () => {
  it('sends directly with fetch and reads the response', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'x-id': '9' } }))

    const result = await send(call, 'direct', signal(), fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/items',
      expect.objectContaining({ method: 'POST', headers: [['X-One', '1']], body: 'olá', credentials: 'omit' }),
    )
    expect(result).toMatchObject({ status: 201, statusText: 'Created', body: '{"ok":true}', size: 11, truncated: false })
    expect(result.headers).toContainEqual(['x-id', '9'])
  })

  it('drops the body of a direct GET', async () => {
    const fetchImpl = vi.fn(async () => new Response(''))

    await send({ ...call, method: 'GET' }, 'direct', signal(), fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/items', expect.objectContaining({ body: undefined }))
  })

  it('reports a direct network failure, the usual symptom of CORS', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(send(call, 'direct', signal(), fetchImpl)).rejects.toMatchObject({
      failure: { kind: 'network', mode: 'direct', message: 'Failed to fetch' },
    })
  })

  it('posts the call to the server proxy as base64', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
        bodyBase64: btoa('pong'),
        truncated: false,
        durationMs: 12,
      }),
    )

    const result = await send(call, 'server', signal(), fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/__alcy/proxy')
    expect(JSON.parse(String(init?.body))).toEqual({
      method: 'POST',
      url: 'https://api.test/items',
      headers: [['X-One', '1']],
      bodyBase64: btoa('olÃ¡'),
    })
    expect(result).toMatchObject({ status: 200, body: 'pong', durationMs: 12 })
  })

  it('surfaces errors returned by the server', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { code: 'hostNotAllowed', message: 'api.test' } }, { status: 403 }),
    )

    const error = await send(call, 'server', signal(), fetchImpl).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).failure).toEqual({ kind: 'server', status: 403, code: 'hostNotAllowed', message: 'api.test' })
  })
})

describe('execute', () => {
  it('fetches an OAuth2 token first and sends it as bearer', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith('/token') ? Response.json({ access_token: 'issued' }) : new Response('done'),
    )

    await execute(
      { ...call, headers: [['Authorization', 'old']] },
      { tokenUrl: 'https://auth.test/token', clientId: 'id', clientSecret: 'secret', scope: 'read' },
      'direct',
      signal(),
      fetchImpl,
    )

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://auth.test/token',
      expect.objectContaining({
        body: 'grant_type=client_credentials&scope=read',
        headers: [
          ['Authorization', `Basic ${btoa('id:secret')}`],
          ['Content-Type', 'application/x-www-form-urlencoded'],
        ],
      }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.test/items',
      expect.objectContaining({ headers: [['Authorization', 'Bearer issued']] }),
    )
  })
})

describe('detectServer', () => {
  it('is false for a local file and true when the server answers', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ service: 'alcy-webclient-server' }))

    await expect(detectServer(fetchImpl, 'file:')).resolves.toBe(false)
    await expect(detectServer(fetchImpl, 'http:')).resolves.toBe(true)
    await expect(detectServer(vi.fn(async () => new Response('', { status: 404 })), 'http:')).resolves.toBe(false)
  })
})
