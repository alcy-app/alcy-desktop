import { describe, expect, it } from 'vitest'
import type { SavedRequestDto } from '../../bindings/list-collections'
import { requestFromDto, requestToDto } from './use-collections-state'

describe('gRPC requests through the saved DTO', () => {
  it('round-trips the call and keeps the message as the body', () => {
    const dto: SavedRequestDto = {
      id: 'r1',
      name: 'Say hello',
      protocol: 'grpc',
      endpoint: 'localhost:50051',
      method: 'post',
      body: '{"name": "{{user}}"}',
      variables: '',
      headers: [{ name: 'x-tenant', value: 'acme', enabled: true }],
      authentication: { type: 'inherit' },
      preRequestScript: '',
      postResponseScript: '',
      grpc: {
        service: 'test.Greeter',
        method: 'SayHello',
        schemaSource: { type: 'protoFiles', files: ['protos/greeter.proto'], importPaths: ['protos'] },
        deadlineMs: 3000,
      },
    }

    const summary = requestFromDto(dto)
    expect(summary.protocol).toBe('grpc')
    expect(summary.content.grpc).toEqual({ ...dto.grpc, message: dto.body })

    const back = requestToDto(summary)
    expect(back.body).toBe(dto.body)
    expect(back.grpc).toEqual(dto.grpc)
    expect(back.restBody).toBeNull()
  })

  it('only gRPC requests carry the call', () => {
    const rest = requestFromDto({
      id: 'r2',
      name: 'Users',
      protocol: 'rest',
      endpoint: 'https://api',
      method: 'get',
      body: '',
      variables: '',
      headers: [],
      authentication: { type: 'none' },
      preRequestScript: '',
      postResponseScript: '',
    })
    expect(requestToDto(rest)).not.toHaveProperty('grpc')
  })
})
