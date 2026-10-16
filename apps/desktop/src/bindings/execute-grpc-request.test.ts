import { beforeEach, expect, it, vi } from 'vitest'
import { executeGrpcRequest, type ExecuteGrpcRequestInput } from './execute-grpc-request'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class { onmessage = () => {} } }))

const input: ExecuteGrpcRequestInput = {
  executionId: 'rpc', rootPath: '/workspace', endpoint: 'localhost:50051',
  service: 'test.Greeter', method: 'SayHello', message: '{}', deadlineMs: null, tabId: 'tab',
  preRequestScript: 'al.environment.set("x", "y")', postResponseScript: '',
  schemaSource: { type: 'reflection' }, authentication: { type: 'none' },
  headers: [], environmentVariables: [], variableScopes: [], requestId: null,
}
beforeEach(() => { invoke.mockReset() })

it('preserves pre-script effects when the native call fails', async () => {
  invoke.mockRejectedValue({ kind: 'connection', message: 'refused', environmentChanges: [{ name: 'x', value: 'y' }], scopedChanges: [], scriptLogs: ['prepared'], testResults: [] })
  const result = await executeGrpcRequest(input)
  expect(result).toEqual({ ok: false, error: { kind: 'connection', message: 'refused' }, environmentChanges: [{ name: 'x', value: 'y' }], scopedChanges: [], scriptLogs: ['prepared'], testResults: [] })
})

it('passes script inputs and forwards channel events', async () => {
  invoke.mockResolvedValue({ status: { code: 0, codeName: 'OK', message: '' } })
  const onEvent = vi.fn()
  await executeGrpcRequest(input, onEvent)
  const [command, args] = invoke.mock.calls[0]
  expect(command).toBe('execute_grpc_request')
  expect(args.input).toEqual(input)
  args.onEvent.onmessage({ type: 'started', kind: 'unary' })
  expect(onEvent).toHaveBeenCalledWith({ type: 'started', kind: 'unary' })
})
