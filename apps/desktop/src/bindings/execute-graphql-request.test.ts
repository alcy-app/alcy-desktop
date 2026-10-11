import { describe, expect, it } from 'vitest'
import { splitExecutionFailure } from './execute-graphql-request'
import type { ExecuteGraphqlRequestError } from './execute-graphql-request'

describe('splitExecutionFailure', () => {
  it('separa do erro os efeitos dos scripts', () => {
    const payload = {
      kind: 'network',
      message: 'connection refused',
      environmentChanges: [{ name: 'token', value: 'abc' }],
      scriptLogs: ['pre'],
    }

    expect(splitExecutionFailure<ExecuteGraphqlRequestError>(payload)).toEqual({
      error: { kind: 'network', message: 'connection refused' },
      environmentChanges: [{ name: 'token', value: 'abc' }],
      scriptLogs: ['pre'],
    })
  })

  it('mantém como erro um payload que não é objeto', () => {
    expect(splitExecutionFailure<string>('falha inesperada')).toEqual({ error: 'falha inesperada' })
  })
})
