import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider } from '../../shared/i18n/LanguageProvider'
import { useEnvironmentsState } from './use-environments-state'

const listEnvironments = vi.fn()
const saveEnvironments = vi.fn()

vi.mock('../../bindings/list-environments', () => ({
  listEnvironments: (...args: unknown[]) => listEnvironments(...args),
}))

vi.mock('../../bindings/save-environments', () => ({
  saveEnvironments: (...args: unknown[]) => saveEnvironments(...args),
}))

function wrapper({ children }: { children: ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>
}

describe('useEnvironmentsState', () => {
  beforeEach(() => {
    listEnvironments.mockReset().mockResolvedValue({
      ok: true,
      value: {
        environments: [{ id: 'dev', name: 'Dev', variables: [{ name: 'baseUrl', value: 'https://api.test', sensitive: false }] }],
        activeEnvironmentId: 'dev',
        unreadableSecrets: [],
      },
    })
    saveEnvironments.mockReset().mockResolvedValue({ ok: true })
  })

  it('salva o ambiente sem as linhas de variável ainda sem nome', async () => {
    const { result } = renderHook(() => useEnvironmentsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.activeEnvironment?.variables).toHaveLength(1))

    act(() => result.current.addVariable('dev'))
    // A linha em branco continua na tabela para ser preenchida.
    expect(result.current.activeEnvironment?.variables).toHaveLength(2)

    await waitFor(() => expect(saveEnvironments).toHaveBeenCalled())
    expect(saveEnvironments.mock.lastCall?.[1].environments[0].variables).toEqual([
      { name: 'baseUrl', value: 'https://api.test', sensitive: false },
    ])
  })

  it('duplica um ambiente logo abaixo do original, com ids novos, e o ativa', async () => {
    listEnvironments.mockResolvedValue({
      ok: true,
      value: {
        environments: [
          {
            id: 'dev',
            name: 'Dev',
            variables: [
              { name: 'baseUrl', value: 'https://api.test', sensitive: false },
              { name: 'token', value: 's3cr3t', sensitive: true },
            ],
          },
          { id: 'prod', name: 'Prod', variables: [] },
        ],
        activeEnvironmentId: 'prod',
        unreadableSecrets: [],
      },
    })
    const { result } = renderHook(() => useEnvironmentsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.environments).toHaveLength(2))

    act(() => result.current.duplicateEnvironment('dev'))

    const [original, copy, prod] = result.current.environments
    expect(prod.id).toBe('prod')
    expect(copy.id).not.toBe(original.id)
    expect(copy.name).toBe('Dev (cópia)')
    expect(copy.variables.map(({ name, value, sensitive }) => ({ name, value, sensitive }))).toEqual([
      { name: 'baseUrl', value: 'https://api.test', sensitive: false },
      { name: 'token', value: 's3cr3t', sensitive: true },
    ])
    expect(copy.variables.map((variable) => variable.id)).not.toEqual(original.variables.map((variable) => variable.id))
    expect(result.current.activeEnvironmentId).toBe(copy.id)

    // Editar a cópia não altera o original.
    act(() => result.current.updateVariable(copy.id, copy.variables[0].id, { value: 'https://copy.test' }))
    expect(result.current.environments[0].variables[0].value).toBe('https://api.test')

    await waitFor(() => expect(saveEnvironments).toHaveBeenCalled())
    expect(saveEnvironments.mock.lastCall?.[1].environments.map((environment: { name: string }) => environment.name)).toEqual([
      'Dev',
      'Dev (cópia)',
      'Prod',
    ])
  })

  it('não salva por cima de um arquivo que não conseguiu ler', async () => {
    listEnvironments.mockResolvedValue({ ok: false, error: { kind: 'storage', message: 'arquivo corrompido' } })
    const { result } = renderHook(() => useEnvironmentsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.loadError).toBe('arquivo corrompido'))

    act(() => {
      result.current.addEnvironment()
    })
    await new Promise((resolve) => setTimeout(resolve, 700))

    expect(saveEnvironments).not.toHaveBeenCalled()
  })

  it('merges imported variables into an existing environment by name and appends new environments', async () => {
    const { result } = renderHook(() => useEnvironmentsState('/workspace'), { wrapper })
    await waitFor(() => expect(result.current.activeEnvironment?.variables).toHaveLength(1))
    const existingRowId = result.current.environments[0].variables[0].id

    act(() =>
      result.current.importEnvironments(
        [{ id: 'imported-environment-1', name: 'Prod', variables: [{ name: 'host', value: 'p', sensitive: false }] }],
        [{ environmentId: 'dev', variables: [{ name: 'baseUrl', value: 'https://new.test', sensitive: false }, { name: 'token', value: 't', sensitive: true }] }],
      ),
    )

    const [dev, prod] = result.current.environments
    expect(dev.variables.map(({ name, value, sensitive }) => ({ name, value, sensitive }))).toEqual([
      { name: 'baseUrl', value: 'https://new.test', sensitive: false },
      { name: 'token', value: 't', sensitive: true },
    ])
    expect(dev.variables[0].id).toBe(existingRowId)
    expect(prod.name).toBe('Prod')
    expect(prod.id).not.toBe('imported-environment-1')
  })
})
