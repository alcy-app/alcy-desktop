import { beforeEach, expect, it, vi } from 'vitest'
import {
  closeWebSocket,
  executeWebSocketRequest,
  sendWebSocketMessage,
  type ExecuteWebSocketRequestInput,
} from './execute-websocket-request'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class { onmessage = () => {} } }))

const input: ExecuteWebSocketRequestInput = {
  executionId: 'ws', rootPath: '/workspace', endpointUrl: 'wss://chat.test', routeParams: [],
  headers: [], authentication: { type: 'none' }, requestId: null, tabId: 'tab',
  environmentVariables: [], variableScopes: [], preRequestScript: 'al.environment.set("x", "y")', postResponseScript: '',
  message: 'hello', websocket: { subprotocols: ['chat'], messageFormat: 'text', waitMs: null, expectedMessages: null },
}
beforeEach(() => { invoke.mockReset() })

it('preserves pre-script effects when the connection fails', async () => {
  invoke.mockRejectedValue({ kind: 'network', message: 'refused', environmentChanges: [{ name: 'x', value: 'y' }], scopedChanges: [], scriptLogs: [], testResults: [] })
  const result = await executeWebSocketRequest(input)
  expect(result).toEqual({ ok: false, error: { kind: 'network', message: 'refused' }, environmentChanges: [{ name: 'x', value: 'y' }], scopedChanges: [], scriptLogs: [], testResults: [] })
})

it('passes the input and forwards channel events', async () => {
  invoke.mockResolvedValue({ statusCode: 101 })
  const onEvent = vi.fn()
  await executeWebSocketRequest(input, onEvent)
  const [command, args] = invoke.mock.calls[0]
  expect(command).toBe('execute_websocket_request')
  expect(args.input).toEqual(input)
  const event = { type: 'message', direction: 'received', index: 0, format: 'text', data: 'hi', truncated: false, sizeBytes: 2, elapsedMs: 3 }
  args.onEvent.onmessage(event)
  expect(onEvent).toHaveBeenCalledWith(event)
})

it('sends and closes through their commands', async () => {
  invoke.mockResolvedValue(null)
  await sendWebSocketMessage('ws', 'AAE=', 'binary')
  await closeWebSocket('ws')
  expect(invoke.mock.calls).toEqual([
    ['send_websocket_message', { input: { executionId: 'ws', message: 'AAE=', format: 'binary' } }],
    ['close_websocket', { executionId: 'ws', code: null, reason: null }],
  ])
})
