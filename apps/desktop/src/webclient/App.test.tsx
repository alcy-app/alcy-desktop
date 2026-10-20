import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { SealedEnvelope, Snapshot } from './types'

const snapshot: Snapshot = {
  version: 1,
  exportId: 'test-export',
  title: 'Users API',
  transport: 'direct',
  environment: {
    name: 'Prod',
    variables: [
      { name: 'baseUrl', value: 'https://api.test' },
      { name: 'token', value: '' },
    ],
  },
  credentials: [{ id: 'variable:token', owner: null, target: { kind: 'variable', name: 'token' }, included: false }],
  root: {
    id: 'root',
    name: 'Users',
    variables: [],
    authentication: { type: 'bearer', token: '{{token}}' },
    folders: [],
    requests: [
      {
        id: 'list',
        name: 'List users',
        protocol: 'rest',
        method: 'GET',
        url: '{{baseUrl}}/users',
        headers: [],
        authentication: { type: 'inherit' },
        body: '',
        bodyPayload: { type: 'none' },
        variables: '',
        routeParameters: [],
        unsupported: [],
      },
    ],
  },
}

/** Same vector as `seal.test.ts`, decrypting to JSON that is not a snapshot. */
const VECTOR: SealedEnvelope = {
  version: 1,
  kdf: 'PBKDF2-SHA256',
  iterations: 1000,
  salt: 'AQIDBAUGBwgJCgsMDQ4PEA==',
  nonce: 'yMnKy8zNzs/Q0dLT',
  ciphertext: '2T2PeruJIpNmUaj9f0TnUygp44h8Dglb++KNjP3DLGCX8nJkVph4zTUUZ5s2MdmENoEEHLw=',
}

afterEach(() => vi.unstubAllGlobals())

/** API calls without the server health probe (`/__alcy/health`). */
const apiCalls = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchMock.mock.calls.filter(([url]) => url !== '/__alcy/health')

describe('webclient App', () => {
  it('asks for missing credentials and sends with them', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('[{"id":1}]', { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App initial={{ kind: 'ready', snapshot }} />)

    const credential = await screen.findByLabelText(/\{\{token\}\}/)
    fireEvent.change(credential, { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByText('200')
    const [url, init] = apiCalls(fetchMock)[0]
    expect(url).toBe('https://api.test/users')
    expect(init?.headers).toEqual([['Authorization', 'Bearer secret-token']])
    expect(screen.getByText(/"id": 1/)).toBeInTheDocument()
    expect(window.localStorage.getItem('alcy-webclient:test-export:credentials')).toBeNull()
  })

  it('remembers credentials only when asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('')))
    render(<App initial={{ kind: 'ready', snapshot }} />)

    fireEvent.change(await screen.findByLabelText(/\{\{token\}\}/), { target: { value: 'kept' } })
    fireEvent.click(screen.getByLabelText('Remember in this browser'))

    expect(JSON.parse(window.localStorage.getItem('alcy-webclient:test-export:credentials') ?? '{}')).toEqual({ 'variable:token': 'kept' })
  })

  it('sends requests with undefined variables preserved', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App initial={{ kind: 'ready', snapshot: { ...snapshot, environment: null } }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByText('200')
    expect(apiCalls(fetchMock)).toHaveLength(1)
    expect(apiCalls(fetchMock)[0][0]).toBe('{{baseUrl}}/users')
  })

  it('warns about exported gRPC requests and never sends them as HTTP', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const grpcSnapshot: Snapshot = { ...snapshot, credentials: [], root: { ...snapshot.root,
      requests: [{ ...snapshot.root.requests[0], name: 'Hello RPC', url: 'localhost:50051', unsupported: ['grpc'] }],
    } }
    render(<App initial={{ kind: 'ready', snapshot: grpcSnapshot }} />)
    expect(screen.getByRole('note')).toHaveTextContent('gRPC requests cannot be sent by the browser; use Alcy.')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This request uses features the webclient does not send.')
    expect(apiCalls(fetchMock)).toEqual([])
  })

  it('unlocks a sealed payload and rejects a wrong password', async () => {
    render(<App initial={{ kind: 'sealed', envelope: VECTOR }} />)

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.')

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    // The vector decrypts to JSON that is not a snapshot.
    await waitFor(() => expect(screen.getByText('This file does not contain a valid Alcy webclient.')).toBeInTheDocument())
  })
})
