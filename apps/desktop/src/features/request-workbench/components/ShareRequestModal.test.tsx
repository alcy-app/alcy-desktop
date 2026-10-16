import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../test-utils'
import { emptyAuthorizationState } from '../authorization-state'
import { emptyBodyState } from '../body-state'
import { emptyGrpcCall } from '../collection-tree'
import { ShareRequestModal } from './ShareRequestModal'

const tab = {
  protocol: 'rest' as const,
  method: 'get' as const,
  endpointUrl: '{{baseUrl}}/users',
  query: '',
  variables: '',
  headers: [],
  routeParams: [],
  body: { ...emptyBodyState, type: 'none' as const },
  authorization: { ...emptyAuthorizationState },
  preRequestScript: '',
  postResponseScript: '',
}

const variables = [{ name: 'baseUrl', value: 'https://api.test', sensitive: false }]

function renderModal(overrides: Partial<typeof tab> = {}) {
  return render(
    <ShareRequestModal
      tab={{ ...tab, ...overrides }}
      inheritedAuthentication={undefined}
      environmentVariables={variables}
      onClose={() => {}}
    />,
  )
}

function preview(): string {
  return screen.getByLabelText('Código gerado').textContent ?? ''
}

describe('ShareRequestModal', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts with cURL and the resolved URL', () => {
    renderModal()
    expect(screen.getByRole('combobox', { name: 'Linguagem' })).toHaveTextContent('cURL')
    expect(preview()).toContain("--url 'https://api.test/users'")
  })

  it('switches the language and remembers the choice', () => {
    const { unmount } = renderModal()
    fireEvent.click(screen.getByRole('combobox', { name: 'Linguagem' }))
    fireEvent.click(screen.getByRole('option', { name: 'Python (requests)' }))
    expect(preview()).toContain('import requests')
    unmount()

    renderModal()
    expect(screen.getByRole('combobox', { name: 'Linguagem' })).toHaveTextContent('Python (requests)')
  })

  it('copies the generated code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Copiar código' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toContain("curl --request GET \\\n  --url 'https://api.test/users'")
    expect(await screen.findByText('Código copiado.')).toBeInTheDocument()
  })

  it('warns that scripts are not included', () => {
    renderModal({ preRequestScript: 'al.console.log(1)' })
    expect(screen.getByText(/não são incluídos no código gerado/)).toBeInTheDocument()
  })

  it('only offers grpcurl for gRPC even when an HTTP language was saved', async () => {
    window.localStorage.setItem('alcy:share:language', 'python-requests')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<ShareRequestModal tab={{ ...tab, protocol: 'grpc', endpointUrl: 'localhost:50051',
      grpc: { ...emptyGrpcCall, service: 'test.Greeter', method: 'Hello' } }}
      inheritedAuthentication={undefined} environmentVariables={[]} onClose={() => {}} />)
    expect(screen.getByRole('combobox', { name: 'Linguagem' })).toHaveTextContent('grpcurl')
    fireEvent.click(screen.getByRole('combobox', { name: 'Linguagem' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(screen.getByRole('option', { name: 'grpcurl' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copiar código' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toContain('grpcurl -plaintext')
    expect(writeText.mock.calls[0][0]).toContain("'test.Greeter/Hello'")
    expect(window.localStorage.getItem('alcy:share:language')).toBe('python-requests')
  })
})
