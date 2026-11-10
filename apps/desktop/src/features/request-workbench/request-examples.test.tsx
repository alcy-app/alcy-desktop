import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '../../test-utils'
import {
  createExample,
  duplicateRequest,
  emptyExampleResponse,
  emptyRequestContent,
  filterTree,
  findExample,
  insertExample,
  regenerateIds,
  removeNode,
  renameNode,
  updateExample,
  type RequestExample,
  type RequestSummary,
  type TreeNode,
} from './collection-tree'
import { ExampleResponsePanel } from './components/ExampleResponsePanel'
import { exampleResponseFromExecution } from './example-response'
import type { ExecutionState, WorkbenchTab } from './request-workbench.types'
import { parseTabSession, resolveTabSession, snapshotTabSession } from './tab-session'
import { contentOf, useWorkbenchState } from './use-workbench-state'
import { requestFromDto, requestToDto } from './use-collections-state'

const example = (id: string, name: string): RequestExample =>
  createExample(id, name, { ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/a' }, emptyExampleResponse)

const request = (examples?: RequestExample[]): RequestSummary => ({
  id: 'r1',
  name: 'Get Models',
  protocol: 'rest',
  content: { ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/a' },
  ...(examples ? { examples } : {}),
})

const tree = (examples?: RequestExample[]): TreeNode[] => [
  { id: 'c1', name: 'API', folders: [], requests: [request(examples)], authentication: { type: 'inherit' }, variables: [] },
]

describe('examples in the collection tree', () => {
  it('leaves authentication and scripts out of a new example', () => {
    const content = {
      ...emptyRequestContent('rest'),
      authentication: { type: 'bearer' as const, token: 'secret' },
      preRequestScript: 'pre()',
      postResponseScript: 'post()',
    }

    const created = createExample('e1', 'Ok', content, emptyExampleResponse)

    expect(created.content.authentication).toEqual({ type: 'inherit' })
    expect(created.content.preRequestScript).toBe('')
    expect(created.content.postResponseScript).toBe('')
  })

  it('inserts after a given example and finds it with its request', () => {
    const nodes = insertExample(tree([example('e1', 'A'), example('e2', 'B')]), 'r1', example('e3', 'C'), 'e1')

    expect(nodes[0].requests[0].examples?.map((item) => item.id)).toEqual(['e1', 'e3', 'e2'])
    expect(findExample(nodes, 'e3')?.request.id).toBe('r1')
    expect(findExample(nodes, 'missing')).toBeNull()
  })

  it('renames, updates and removes an example by its id alone', () => {
    let nodes = renameNode(tree([example('e1', 'A')]), 'e1', 'Renamed')
    expect(findExample(nodes, 'e1')?.example.name).toBe('Renamed')

    nodes = updateExample(nodes, { ...example('e1', 'Renamed'), response: { ...emptyExampleResponse, statusCode: 404 } })
    expect(findExample(nodes, 'e1')?.example.response.statusCode).toBe(404)

    nodes = removeNode(nodes, 'e1')
    expect(nodes[0].requests).toHaveLength(1)
    expect(nodes[0].requests[0].examples).toEqual([])
  })

  it('gives copies of a request new example ids', () => {
    const nodes = duplicateRequest(tree([example('e1', 'A')]), 'r1', 'r2', 'Copy')
    const [original, copy] = nodes[0].requests

    expect(copy.examples?.[0].name).toBe('A')
    expect(copy.examples?.[0].id).not.toBe(original.examples?.[0].id)

    let next = 0
    const regenerated = regenerateIds(tree([example('e1', 'A')])[0], () => `new-${++next}`)
    expect(regenerated.requests[0].examples?.[0].id).toMatch(/^new-/)
  })

  it('matches a search on the name of an example', () => {
    expect(filterTree(tree([example('e1', 'Not found')]), 'not found')[0].requests).toHaveLength(1)
    expect(filterTree(tree([example('e1', 'Not found')]), 'teapot')).toEqual([])
  })

  it('survives the DTO round trip, and stays absent when there are none', () => {
    const withExample = request([example('e1', 'A')])

    expect(requestFromDto(requestToDto(withExample)).examples).toEqual(withExample.examples)
    expect(requestToDto(request())).not.toHaveProperty('examples')
  })
})

describe('saving a response as an example', () => {
  const success = (body: Record<string, unknown>, bodyEncoding: string): ExecutionState =>
    ({
      status: 'success',
      result: { statusCode: 201, body, bodyEncoding, headers: [{ name: 'Content-Type', value: 'application/json' }] },
    }) as unknown as ExecutionState

  it('copies status, headers and body and detects the language', () => {
    expect(exampleResponseFromExecution(success({ kind: 'inline', body: '{}' }, 'text'))).toEqual({
      statusCode: 201,
      headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
      body: '{}',
      language: 'json',
    })
  })

  it('refuses bodies that are binary or not fully in memory', () => {
    expect(exampleResponseFromExecution(success({ kind: 'inline', body: 'AAAA' }, 'base64'))).toBeNull()
    expect(exampleResponseFromExecution(success({ kind: 'windowed', handle: 'h' }, 'text'))).toBeNull()
    expect(exampleResponseFromExecution({ status: 'idle' })).toBeNull()
  })
})

describe('example tabs', () => {
  const setup = () => renderHook(() => useWorkbenchState([], '/root', tree([example('e1', 'A')])))

  it('tracks edits to the response and clears them on save', () => {
    const { result } = setup()
    act(() => result.current.openExample('r1', example('e1', 'A')))
    expect(result.current.activeTab.dirty).toBe(false)
    expect(result.current.activeTab.requestId).toBeNull()

    act(() => result.current.updateExampleResponse({ statusCode: 500 }))
    expect(result.current.activeTab.dirty).toBe(true)

    act(() => result.current.markExampleSaved(result.current.activeTab.id))
    expect(result.current.activeTab.dirty).toBe(false)
  })

  it('activates the tab already showing an example', () => {
    const { result } = setup()
    act(() => result.current.openExample('r1', example('e1', 'A')))
    act(() => result.current.openExample('r1', example('e1', 'A')))

    expect(result.current.tabs).toHaveLength(1)
  })

  it('reuses the tab of a previous try with the new content', () => {
    const { result } = setup()
    const content = { ...emptyRequestContent('rest'), endpointUrl: 'https://api.test/first' }
    act(() => {
      result.current.openTriedExample('e1', 'r1', 'A', content)
    })
    act(() => {
      result.current.openTriedExample('e1', 'r1', 'A', { ...content, endpointUrl: 'https://api.test/second' })
    })

    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeTab.endpointUrl).toBe('https://api.test/second')
    expect(result.current.activeTab.scopeRequestId).toBe('r1')
    expect(result.current.activeTab.dirty).toBe(false)
  })
})

describe('example tabs in the session', () => {
  const saved = example('e1', 'A')
  const exampleTab = (overrides: Partial<WorkbenchTab>): WorkbenchTab => {
    const { result } = renderHook(() => useWorkbenchState([], '/root', []))
    act(() => result.current.openExample('r1', saved, false))
    return { ...result.current.activeTab, ...overrides }
  }
  const roundTrip = (tab: WorkbenchTab, nodes: TreeNode[]) => {
    const parsed = parseTabSession(JSON.parse(JSON.stringify(snapshotTabSession([tab], tab.id, contentOf))))
    return resolveTabSession(parsed!, nodes)
  }

  it('reloads a clean tab from the collection', () => {
    const [restored] = roundTrip(exampleTab({}), tree([saved]))

    expect(restored.requestId).toBeNull()
    expect(restored.example?.requestId).toBe('r1')
    expect(restored.content).toEqual(saved.content)
  })

  it('keeps unsaved response edits', () => {
    const response = { ...emptyExampleResponse, statusCode: 418 }
    const tab = exampleTab({ dirty: true, example: { exampleId: 'e1', response, savedResponse: emptyExampleResponse } })

    const [restored] = roundTrip(tab, tree([saved]))

    expect(restored.example?.state.response.statusCode).toBe(418)
    expect(restored.example?.state.savedResponse.statusCode).toBe(200)
  })

  it('drops the tab of an example that no longer exists', () => {
    expect(roundTrip(exampleTab({}), tree())).toEqual([])
  })
})

describe('ExampleResponsePanel', () => {
  it('keeps only digits in the status code', () => {
    const changes: unknown[] = []
    render(
      <ExampleResponsePanel tabId="t" response={emptyExampleResponse} onChange={(patch) => changes.push(patch)} environmentVariables={[]} />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Código de status' }), { target: { value: '40a4' } })

    expect(changes).toEqual([{ statusCode: 404 }])
  })

  it('adds and removes response headers', () => {
    const changes: unknown[] = []
    const response = { ...emptyExampleResponse, headers: [{ name: 'X-One', value: '1', enabled: true }] }
    render(<ExampleResponsePanel tabId="t" response={response} onChange={(patch) => changes.push(patch)} environmentVariables={[]} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }))
    fireEvent.click(screen.getByRole('button', { name: /Adicionar/ }))

    expect(changes).toEqual([{ headers: [...response.headers, { name: '', value: '', enabled: true }] }])
  })
})
