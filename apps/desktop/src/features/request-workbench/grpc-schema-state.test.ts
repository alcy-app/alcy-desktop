import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { emptyGrpcCall, emptyRequestContent } from './collection-tree'
import { useWorkbenchState } from './use-workbench-state'

const load = vi.hoisted(() => vi.fn())
vi.mock('../../bindings/load-grpc-schema', () => ({ loadGrpcSchema: load }))
const noVariables: never[] = []
const noCollections: never[] = []
const loaded = { ok: true, value: { services: [] } }

beforeEach(() => load.mockReset())

it('ignores an old load after changing the schema source and loads the new source on refresh', async () => {
  let finish!: (value: unknown) => void
  load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const { result } = renderHook(() => useWorkbenchState(noVariables, '/ws', noCollections))
  act(() => result.current.newDraftTab('grpc', 'Call'))
  act(() => result.current.setEndpointUrl('grpc://localhost:50051'))
  let pending!: Promise<void>
  act(() => { pending = result.current.loadGrpcSchema(false) })
  expect(result.current.grpcSchema.status).toBe('loading')
  const schemaSource = { type: 'protoFiles', files: ['hello.proto'], importPaths: ['protos'] } as const
  act(() => result.current.updateGrpc({ schemaSource: { ...schemaSource, files: [...schemaSource.files], importPaths: [...schemaSource.importPaths] } }))
  await act(async () => { finish(loaded); await pending })
  expect(result.current.grpcSchema.status).toBe('idle')
  load.mockResolvedValueOnce(loaded)
  await act(async () => result.current.loadGrpcSchema(true))
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ schemaSource, forceRefresh: true }))
  expect(result.current.grpcSchema.status).toBe('success')
})

it('clears loaded services after changing endpoints or importing a replacement request', async () => {
  load.mockResolvedValue(loaded)
  const { result } = renderHook(() => useWorkbenchState(noVariables, '/ws', noCollections))
  act(() => result.current.newDraftTab('grpc', 'Call'))
  await act(async () => result.current.loadGrpcSchema(false))
  act(() => result.current.setEndpointUrl('grpcs://other.test:443'))
  expect(result.current.grpcSchema.status).toBe('idle')
  await act(async () => result.current.loadGrpcSchema(false))
  act(() => result.current.replaceTabContent(result.current.activeTabId!, {
    ...emptyRequestContent('grpc'), endpointUrl: 'grpc://imported.test:9000',
    grpc: { ...emptyGrpcCall, service: 'Svc', method: 'Call', message: '{}' },
  }))
  expect(result.current.grpcSchema.status).toBe('idle')
  expect(result.current.grpc.service).toBe('Svc')
})
