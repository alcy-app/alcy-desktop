import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import type { FlowDto, FlowFolderDto } from '../../bindings/list-flows'
import { evaluateValueMonitors, type MonitorCandidateInput } from '../../bindings/evaluate-value-monitors'
import { getCollectionRunOutput } from '../../bindings/get-collection-run-output'
import { cancelFlowOutputQuery, inspectFlowOutput } from '../../bindings/inspect-flow-output'
import { previewLoadFlow } from '../../bindings/preview-load-flow'
import { checkFlow, type FlowIssueDto } from '../../bindings/check-flow'
import { clearMockCalls, deleteMockServer, getMockServer, listMockCalls, listMockServers, saveMockServer, startMockServer, stopMockServer, validateMockServer, type MockServerDto } from '../../bindings/mock-servers'
import type { AgentContextInput } from '../../bindings/agent-turn'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { translate as translateTo, type TranslationKey } from '../../shared/i18n/translations'
import { createFlow, createLoadFlow, dtoFromFlow, flowFromDto, type useFlowsState } from '../flows/use-flows-state'
import { createFlowFromTemplate, FLOW_TEMPLATES, type FlowTemplateId } from '../flows/flow-templates'
import { runFlowLayout } from '../flows/flow-layout-runner'
import type { useValueMonitorsState } from '../value-monitors/use-value-monitors-state'
import type { useCollectionsState } from '../request-workbench/use-collections-state'
import type { useEnvironmentsState } from '../environments/use-environments-state'
import type { useOpenTabs } from '../request-workbench/use-open-tabs'
import type { useWorkbenchState } from '../request-workbench/use-workbench-state'
import { contentOf, isTabDirty } from '../request-workbench/use-workbench-state'
import { descendantIds, duplicateRequest, emptyRequestContent, findNode, findParentId, findRequest, insertFolder, insertRequest, moveItems, regenerateIds, removeNode, renameNode, updateNodeAuthentication, updateNodeVariables, updateRequestContent, type TreeNode } from '../request-workbench/collection-tree'
import { DEFAULT_RUNNER_SETTINGS, toRunOptions } from '../collection-runner/runner-settings'
import { runStateFromDetail, summarizeRun } from '../collection-runner/collection-run-state'
import { MOCK_SERVERS_CHANGED_EVENT } from '../mock-servers/mock-server-defaults'
import { getFlowRunState } from '../flows/flow-run-session'
import { getLoadFlowRunState } from '../flows/load-flow-run-session'
import { boundedResource, mergeResource, page, record, redactResource, resourceSecrets, string, strings } from './agent-resource-data'
import { isResourceTool, patchMonitor } from './agent-resource-tools'
import { addFlowNode, connectFlowNodes, describeFlowNode, disconnectFlowNodes, findFlowNode, flowOutline, flowReferences, layoutGraph, organizeFlow, patchFlow } from './agent-flow-tools'
import { flowGuide } from './agent-flow-guide'
import type { AgentResourceBridge } from './agent-resource-bridge'
import { applyRequestPatch, type AgentToolOutcome } from './agent-tools'

export interface AgentResourceHost {
  cancelReads?(): void
  tabs?(): { tabId: string; name: string; kind: string; unsaved: boolean; active: boolean }[]
  needsApproval?(name: string, input: Record<string, unknown>): boolean
  call(name: string, input: Record<string, unknown>): Promise<AgentToolOutcome>
  context(): AgentContextInput[]
  summary(name: string, input: Record<string, unknown>): string
  fingerprint(name: string, input: Record<string, unknown>): string | undefined
}

interface Sources {
  rootPath: string
  bridge: AgentResourceBridge
  flows: ReturnType<typeof useFlowsState>
  monitors: ReturnType<typeof useValueMonitorsState>
  collections: ReturnType<typeof useCollectionsState>
  environments: ReturnType<typeof useEnvironmentsState>
  openTabs: ReturnType<typeof useOpenTabs>
  workbench: ReturnType<typeof useWorkbenchState>
  onSaved(): void
  /** Interface language for flows made from templates; English by default. */
  translate?: (key: TranslationKey) => string
}

/** Graph edits run without approval and can be undone from the chat (spec 0139). */
const FLOW_EDIT_TOOLS = ['add_flow_node', 'connect_flow_nodes', 'disconnect_flow_nodes', 'organize_flow', 'update_flow', 'rename_flow_node']

function variableNames(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [...node.variables.map((variable) => variable.name), ...variableNames(node.folders)])
}

function issueLines(issues: FlowIssueDto[]): string {
  return issues.map((issue) => `- ${issue.nodeId ? `[${issue.nodeId}] ` : ''}${issue.message} Fix: ${issue.fix}`).join('\n')
}

/** Request fields shared with update_request; a duplicate applies them to the copy. */
const REQUEST_FIELDS = ['method', 'url', 'headers', 'body', 'query', 'variables', 'authentication', 'preRequestScript', 'postResponseScript'] as const

function unwrap<T>(result: { ok: true; value?: T } | { ok: false; error: { kind: string; message?: string } }): T {
  if (!result.ok) throw new Error(result.error.message ?? result.error.kind)
  return result.value as T
}

function filter<T extends { name: string }>(items: T[], input: Record<string, unknown>): T[] {
  const query = typeof input.query === 'string' ? input.query.toLowerCase().trim() : ''
  return items.filter((item) => item.name.toLowerCase().includes(query))
}

/** All actions read the latest render; saved resources are published only after native validation. */
export function useAgentResources(sources: Sources): AgentResourceHost {
  const latest = useRef(sources)
  const waiters = useRef<(() => void)[]>([])
  const [, acknowledge] = useReducer((revision: number) => revision + 1, 0)
  useLayoutEffect(() => {
    latest.current = sources
    const pending = waiters.current
    waiters.current = []
    pending.forEach((resolve) => resolve())
  })
  const host = useMemo(() => {
    const inspections = new Set<string>()
    const loadPreviews = new Map<string, { fingerprint: string; preview: unknown }>()
    const settle = () => new Promise<void>((resolve) => {
      waiters.current.push(resolve)
      acknowledge()
      window.setTimeout(resolve, 200)
    })
    const source = () => latest.current
    const secrets = (extra?: unknown) => resourceSecrets([source().environments.environments, source().collections.collections, source().flows.flows, extra])
    const flow = (id: string): FlowDto => {
      const current = source().flows.flows.find((item) => item.id === id)
      if (!current) throw new Error(`No flow '${id}'. Use list_flows.`)
      if (current.executionKind === 'load' && !FEATURE_FLAGS.loadTesting) throw new Error('Load testing is disabled.')
      return source().bridge.get('flow', id)?.read() ?? dtoFromFlow(current)
    }
    const loadFingerprint = (id: string) => JSON.stringify([source().rootPath, flow(id), source().environments.activeEnvironmentId, source().environments.environments])
    const mountedFlow = async (id: string) => {
      flow(id)
      source().openTabs.openFlow(id)
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 20))
        const controller = source().bridge.get('flow', id)
        if (controller) return controller
      }
      throw new Error('The flow editor is not ready. Try again.')
    }
    const runner = (id: string) => {
      const controller = source().bridge.get('runner', id)
      if (!controller) throw new Error(`No configurable runner '${id}'. Use open_runner.`)
      return controller
    }
    const monitor = (id: string) => {
      if (!FEATURE_FLAGS.valueMonitors) throw new Error('Value monitors are disabled.')
      const current = source().monitors.monitors.find((item) => item.id === id)
      if (!current) throw new Error(`No monitor '${id}'. Use list_value_monitors.`)
      return current
    }
    const mockChanged = () => { source().onSaved(); window.dispatchEvent(new Event(MOCK_SERVERS_CHANGED_EVENT)) }
    const inlineMock = (id: string) => source().openTabs.mockServerTabs.find((tab) => tab.serverId === id)?.flowNodeRef
    const mock = async (id: string) => {
      const controller = source().bridge.get('mock', id)
      const current = controller?.read()
      if (current?.busy) throw new Error('The mock editor is busy.')
      if (current?.server) return current.server
      return unwrap(await getMockServer(source().rootPath, id))
    }
    const mountedMock = async (id: string) => {
      const current = await mock(id)
      if (inlineMock(id)) source().openTabs.selectOpenTab(id)
      else source().openTabs.openMockServer(id, current.name)
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 20))
        const controller = source().bridge.get('mock', id)
        if (controller?.read().server) return controller
      }
      throw new Error('The mock editor is not ready. Try again.')
    }
    const saveFlow = async (next: FlowDto, folderId: unknown = undefined) => {
      const controller = source().bridge.get('flow', next.id)
      const graphRevision = (value: FlowDto) => JSON.stringify([value.nodes, value.edges, value.presentation])
      const before = controller ? graphRevision(controller.read()) : undefined
      if (controller && record(controller.status()).isRunning) throw new Error('Cannot edit a running flow.')
      await source().flows.commitSnapshot((current) => {
        const folders = current.folders.map((folder) => ({ ...folder, flowIds: [...folder.flowIds] }))
        if (folderId !== undefined) {
          if (folderId !== null && !folders.some((folder) => folder.id === folderId)) throw new Error('Unknown flow folder.')
          for (const folder of folders) folder.flowIds = folder.flowIds.filter((id) => id !== next.id)
          folders.find((folder) => folder.id === folderId)?.flowIds.push(next.id)
        }
        const found = current.flows.some((item) => item.id === next.id)
        return { folders, flows: found ? current.flows.map((item) => item.id === next.id ? flowFromDto(next) : item) : [...current.flows, flowFromDto(next)] }
      })
      const currentController = source().bridge.get('flow', next.id)
      if (before !== undefined && currentController && before !== graphRevision(currentController.read())) {
        const edited = currentController.read()
        await source().flows.commitSnapshot((current) => ({ ...current, flows: current.flows.map((item) => item.id === next.id ? flowFromDto(edited) : item) }))
        throw new Error('The canvas changed while saving. Your manual edits were kept; read the flow again.')
      }
      currentController?.replace(next)
      loadPreviews.delete(next.id)
      await settle()
    }
    const checkEnvironment = (id: string) => {
      const current = source().environments.environments.find((item) => item.id === id)
      if (!current) throw new Error(`No environment '${id}'.`)
      return current
    }
    const checkItem = (id: string) => {
      const current = findNode(source().collections.collections, id) ?? findRequest(source().collections.collections, id)
      if (!current) throw new Error(`No collection item '${id}'.`)
      return current
    }

    const requestName = (id: string) => findRequest(source().collections.collections, id)?.name
    const activeVariables = () => {
      const s = source()
      return s.environments.environments.find((item) => item.id === s.environments.activeEnvironmentId)?.variables.map((variable) => variable.name) ?? []
    }
    /** Native checks plus the saved requests only the workbench knows. */
    const flowIssues = async (current: FlowDto): Promise<FlowIssueDto[]> => {
      const missing: FlowIssueDto[] = current.nodes.flatMap((node) => node.kind === 'request' && !requestName(node.requestId)
        ? [{ severity: 'error' as const, nodeId: node.id, message: `Node '${node.id}' uses saved request '${node.requestId}', which does not exist.`, fix: 'Use a requestId from search_collections, or an inlineRequest node.' }]
        : [])
      const known = [...activeVariables(), ...variableNames(source().collections.collections)]
      return [...missing, ...await checkFlow(current, known)]
    }
    const editFlow = async (id: string, change: (current: FlowDto) => { flow: FlowDto; result: Record<string, unknown> }) => {
      const { flow: next, result } = change(flow(id))
      await saveFlow({ ...next, updatedAtMs: Date.now() })
      return { flowId: id, ...result }
    }

    const call = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      const s = source()
      if (name.includes('value_monitor') && !FEATURE_FLAGS.valueMonitors) throw new Error('Value monitors are disabled.')
      switch (name) {
        case 'list_flows': return { ...page(filter(s.flows.flows.filter((item) => item.executionKind !== 'load' || FEATURE_FLAGS.loadTesting), input).map((item) => ({ id: item.id, name: item.name, executionKind: item.executionKind, nodesCount: item.nodes.length, folderId: s.flows.folders.find((folder) => folder.flowIds.includes(item.id))?.id ?? null })), input), folders: page(s.flows.folders, input) }
        case 'get_flow': {
          const current = flow(string(input, 'flowId'))
          if (input.nodeId !== undefined) return describeFlowNode(findFlowNode(current, input.nodeId))
          const { nodes, edges, ...metadata } = current
          if (input.view === 'full') return { ...metadata, nodes: page(nodes.map(describeFlowNode), input), edges: page(edges, input) }
          return { ...metadata, nodes: page(flowOutline(current, requestName), input), hint: 'next maps each output to the nodes it leads to. Read one node in full with nodeId.' }
        }
        case 'get_flow_guide': return flowGuide(input.topic)
        case 'get_flow_references': return flowReferences(flow(string(input, 'flowId')), input.nodeId, activeVariables())
        case 'check_flow': {
          const issues = await flowIssues(flow(string(input, 'flowId')))
          const errors = issues.filter((issue) => issue.severity === 'error').length
          return { ok: errors === 0, errors, warnings: issues.length - errors, issues, ...(errors === 0 ? { next: 'Run it with run_flow.' } : {}) }
        }
        case 'add_flow_node': return editFlow(string(input, 'flowId'), (current) => addFlowNode(current, input))
        case 'connect_flow_nodes': return editFlow(string(input, 'flowId'), (current) => connectFlowNodes(current, input))
        case 'disconnect_flow_nodes': return editFlow(string(input, 'flowId'), (current) => disconnectFlowNodes(current, input))
        case 'organize_flow': {
          const id = string(input, 'flowId')
          const positions = await runFlowLayout(layoutGraph(flow(id)))
          return editFlow(id, (current) => ({ flow: organizeFlow(current, positions), result: { organized: true } }))
        }
        case 'create_flow': {
          if (input.executionKind !== undefined && input.executionKind !== 'standard' && input.executionKind !== 'load') throw new Error('Invalid executionKind.')
          if (input.executionKind === 'load' && !FEATURE_FLAGS.loadTesting) throw new Error('Load testing is disabled.')
          if (input.template !== undefined && input.requestIds !== undefined) throw new Error('Use either template or requestIds, not both.')
          const flowName = string(input, 'name').trim()
          let base: FlowDto
          if (input.template !== undefined) {
            const template = FLOW_TEMPLATES.find((item) => item.id === input.template)
            if (!template) throw new Error(`Unknown template '${String(input.template)}'. Templates: ${FLOW_TEMPLATES.map((item) => item.id).join(', ')}.`)
            if (template.executionKind === 'load' && !FEATURE_FLAGS.loadTesting) throw new Error('Load testing is disabled.')
            const t = s.translate ?? ((key: TranslationKey) => translateTo('en', key))
            base = dtoFromFlow({ ...createFlowFromTemplate(template.id as FlowTemplateId, t), name: flowName })
          } else if (input.requestIds !== undefined) {
            base = dtoFromFlow(createFlow(flowName))
            let after = 'start'
            for (const requestId of strings(input.requestIds, 'requestIds')) {
              const label = requestName(requestId)
              if (!label) throw new Error(`No saved request '${requestId}'. Use search_collections.`)
              const added = addFlowNode(base, { kind: 'request', requestId, name: label, after })
              base = added.flow
              after = String(added.result.nodeId)
            }
          } else base = dtoFromFlow(input.executionKind === 'load' ? createLoadFlow(flowName) : createFlow(flowName))
          const { flow: next, notes } = patchFlow(base, input)
          await saveFlow(next, input.folderId)
          s.openTabs.openFlow(next.id)
          const last = next.nodes[next.nodes.length - 1]?.id ?? 'start'
          return { flowId: next.id, name: next.name, nodes: flowOutline(next, requestName), ...(notes.length ? { notes } : {}), next: `Add steps with add_flow_node (after: '${last}'), then check_flow.` }
        }
        case 'update_flow': {
          const { flow: next, notes } = patchFlow(flow(string(input, 'flowId')), input)
          await saveFlow(next, input.folderId)
          return { flowId: next.id, updated: true, ...(notes.length ? { notes } : {}) }
        }
        case 'duplicate_flow': {
          const original = flow(string(input, 'flowId'))
          const now = Date.now()
          const next = { ...original, id: crypto.randomUUID(), name: typeof input.name === 'string' ? string(input, 'name') : `${original.name} copy`, createdAtMs: now, updatedAtMs: now }
          await saveFlow(next, input.folderId)
          return { flowId: next.id }
        }
        case 'rename_flow_node': {
          const id = string(input, 'flowId')
          const controller = await mountedFlow(id)
          controller.renameNode(string(input, 'nodeId'), string(input, 'name'))
          await settle()
          await saveFlow(source().bridge.get('flow', id)!.read())
          return { flowId: id, nodeId: input.name }
        }
        case 'delete_flow': {
          const id = string(input, 'flowId')
          flow(id)
          const status = source().bridge.get('flow', id)?.status() ?? (flow(id).executionKind === 'load' ? getLoadFlowRunState(s.rootPath, id) : getFlowRunState(s.rootPath, id))
          if (status && record(status).isRunning) throw new Error('Cancel the running flow before deleting it.')
          await s.flows.commitSnapshot((current) => ({ flows: current.flows.filter((item) => item.id !== id), folders: current.folders.map((folder) => ({ ...folder, flowIds: folder.flowIds.filter((flowId) => flowId !== id) })) }))
          s.openTabs.closeOpenTab(id)
          return { deletedFlowId: id }
        }
        case 'manage_flow_folder': {
          const action = string(input, 'action')
          const id = action === 'create' ? crypto.randomUUID() : string(input, 'folderId')
          await s.flows.commitSnapshot((current) => {
            if (action !== 'create' && !current.folders.some((folder) => folder.id === id)) throw new Error('Unknown flow folder.')
            let folders: FlowFolderDto[]
            if (action === 'create') folders = [...current.folders, { id, name: string(input, 'name'), flowIds: [] }]
            else if (action === 'rename') folders = current.folders.map((folder) => folder.id === id ? { ...folder, name: string(input, 'name') } : folder)
            else if (action === 'delete') folders = current.folders.filter((folder) => folder.id !== id)
            else throw new Error('Unknown folder action.')
            return { ...current, folders }
          })
          return { folderId: id, action }
        }
        case 'open_flow': await mountedFlow(string(input, 'flowId')); return { flowId: input.flowId }
        case 'preview_flow': {
          const id = string(input, 'flowId')
          const current = flow(id)
          await saveFlow(current)
          if (current.executionKind !== 'load') return { flowId: id, executionKind: current.executionKind }
          const preview = unwrap(await previewLoadFlow(s.rootPath, id))
          loadPreviews.set(id, { fingerprint: loadFingerprint(id), preview })
          return preview
        }
        case 'run_flow': {
          const id = string(input, 'flowId')
          if (flow(id).executionKind === 'load' && loadPreviews.get(id)?.fingerprint !== loadFingerprint(id)) throw new Error('Call preview_flow first to review the current load and destinations.')
          const blocking = (await flowIssues(flow(id))).filter((issue) => issue.severity === 'error')
          if (blocking.length > 0) throw new Error(`The flow would fail; fix these first (check_flow lists them):\n${issueLines(blocking)}`)
          return (await mountedFlow(id)).run()
        }
        case 'get_flow_run': {
          const id = string(input, 'flowId')
          flow(id)
          const current = s.bridge.get('flow', id)?.status() ?? (flow(id).executionKind === 'load' ? getLoadFlowRunState(s.rootPath, id) : getFlowRunState(s.rootPath, id))
          if (!current) return { status: 'notStarted' }
          const fullState = record(current)
          const statuses = fullState.statuses
          const state = Object.fromEntries(Object.entries(fullState).filter(([key]) => !['statuses', 'logEntries', 'runNodes', 'formDrafts'].includes(key)))
          const entries = statuses ? Object.entries(record(statuses)).map(([nodeId, status]) => ({ nodeId, status: record(status, 'status') })) : []
          const failed = entries.filter((entry) => entry.status.status === 'failed').map((entry) => ({ nodeId: entry.nodeId, message: entry.status.message }))
          const waitingForUser = entries.filter((entry) => entry.status.status === 'waitingForHuman').map((entry) => entry.nodeId)
          return { ...state, ...(failed.length ? { failed } : {}), ...(waitingForUser.length ? { waitingForUser } : {}), statuses: statuses ? page(entries, input) : undefined }
        }
        case 'cancel_flow': {
          const id = string(input, 'flowId')
          return (await mountedFlow(id)).cancel() ?? { flowId: id, status: 'cancelling' }
        }
        case 'get_flow_output': {
          const id = string(input, 'flowId')
          flow(id)
          const state = record(s.bridge.get('flow', id)?.status() ?? getFlowRunState(s.rootPath, id) ?? {})
          const executionId = state.flowExecutionId
          if (typeof executionId !== 'string') throw new Error('The flow has no standard execution output.')
          const queryId = crypto.randomUUID()
          inspections.add(queryId)
          try {
            return await inspectFlowOutput({ rootPath: s.rootPath, flowExecutionId: executionId, nodeId: string(input, 'nodeId'), queryId, pointer: typeof input.pointer === 'string' ? input.pointer : undefined, cursor: typeof input.cursor === 'string' ? input.cursor : undefined, text: input.text === true })
          } finally { inspections.delete(queryId) }
        }
        case 'list_value_monitors': return page(filter(s.monitors.monitors, input).map(({ id, name: label, enabled, fields, rules }) => ({ id, name: label, enabled, fieldsCount: fields.length, rulesCount: rules.length })), input)
        case 'get_value_monitor': {
          const current = monitor(string(input, 'monitorId'))
          return { ...current, fields: page(current.fields, input), rules: page(current.rules, input) }
        }
        case 'create_value_monitor': {
          const next = patchMonitor({ id: crypto.randomUUID(), name: string(input, 'name'), enabled: true, fields: [], rules: [] }, input)
          await s.monitors.commitMonitors((current) => [...current, next])
          return { monitorId: next.id }
        }
        case 'update_value_monitor': {
          const next = patchMonitor(monitor(string(input, 'monitorId')), input)
          await s.monitors.commitMonitors((current) => current.map((item) => item.id === next.id ? next : item))
          return { monitorId: next.id }
        }
        case 'delete_value_monitor': {
          const current = monitor(string(input, 'monitorId'))
          await s.monitors.commitMonitors((items) => items.filter((item) => item.id !== current.id))
          return { deletedMonitorId: current.id }
        }
        case 'evaluate_value_monitors': {
          if (!Array.isArray(input.values) || input.values.length > 100) throw new Error('values must contain at most 100 candidates.')
          const monitors = input.monitorId ? [monitor(string(input, 'monitorId'))] : s.monitors.monitors
          return unwrap(await evaluateValueMonitors(monitors, input.values as MonitorCandidateInput[]))
        }
        case 'list_runners': return page(s.openTabs.runnerTabs.map((tab) => ({ runnerId: tab.id, name: tab.label, scopeId: tab.scopeId, readOnly: tab.report !== null })), input)
        case 'open_runner': {
          const scopeId = string(input, 'scopeId')
          const node = findNode(s.collections.collections, scopeId)
          if (!node) throw new Error('scopeId must identify a collection or folder.')
          const id = `runner:${scopeId}`
          s.openTabs.openRunner({ id, label: `Runner · ${node.name}`, scopeId, report: null })
          for (let attempt = 0; attempt < 100 && !source().bridge.get('runner', id); attempt++) await new Promise((resolve) => window.setTimeout(resolve, 20))
          runner(id)
          return { runnerId: id }
        }
        case 'get_runner': {
          const report = s.openTabs.runnerTabs.find((tab) => tab.id === input.runnerId)?.report
          if (report) return { runnerId: input.runnerId, readOnly: true, runId: report.id, options: report.options, requestIds: page(report.plan.map((item) => item.requestId), input), phase: 'finished' }
          const { state, ...configuration } = runner(string(input, 'runnerId')).read()
          const dataFile = configuration.dataFile.status === 'ready' ? { status: 'ready', fileName: configuration.dataFile.preview.fileName, columns: configuration.dataFile.preview.columns, rowCount: configuration.dataFile.preview.rowCount } : { status: configuration.dataFile.status }
          return { ...configuration, dataFile, requestIds: page(configuration.requestIds, input), runId: state.runId, phase: state.phase }
        }
        case 'configure_runner': {
          const controller = runner(string(input, 'runnerId'))
          const previous = controller.read()
          const options = input.options === undefined ? {} : record(input.options, 'options')
          const settings = { ...previous.settings }
          for (const [key, value] of Object.entries(options)) {
            if (!(key in DEFAULT_RUNNER_SETTINGS)) throw new Error(`Unknown runner option '${key}'.`)
            if (key === 'iterations' || key === 'delayMs') {
              if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer.`)
              settings[key] = String(value)
            } else {
              if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`)
              Object.assign(settings, { [key]: value })
            }
          }
          if (!toRunOptions(settings)) throw new Error('Invalid runner options.')
          controller.configure({ settings, requestIds: input.requestIds === undefined ? previous.requestIds : strings(input.requestIds, 'requestIds') })
          await settle()
          return { runnerId: input.runnerId, updated: true }
        }
        case 'pick_runner_data_file': await runner(string(input, 'runnerId')).pickDataFile(); return { runnerId: input.runnerId }
        case 'clear_runner_data_file': runner(string(input, 'runnerId')).clearDataFile(); return { runnerId: input.runnerId }
        case 'run_runner': return { runnerId: input.runnerId, runId: await runner(string(input, 'runnerId')).run(), status: 'starting' }
        case 'get_runner_run': {
          const report = s.openTabs.runnerTabs.find((tab) => tab.id === input.runnerId)?.report
          const current = report ? { state: runStateFromDetail(report), error: null } : runner(string(input, 'runnerId')).read()
          return { runId: current.state.runId, phase: current.state.phase, summary: summarizeRun(current.state), current: current.state.current, error: current.error, steps: page(current.state.steps, input) }
        }
        case 'cancel_runner': runner(string(input, 'runnerId')).cancel(); return { runnerId: input.runnerId, status: 'cancelling' }
        case 'get_runner_output': {
          const report = s.openTabs.runnerTabs.find((tab) => tab.id === input.runnerId)?.report
          if (report) return report.outputs.find((output) => output.iteration === input.iteration && output.position === input.position) ?? null
          const current = runner(string(input, 'runnerId')).read().state
          if (!current.runId || typeof input.iteration !== 'number' || typeof input.position !== 'number') throw new Error('A completed step, iteration and position are required.')
          if (!current.steps.some((step) => step.iteration === input.iteration && step.position === input.position)) throw new Error('Unknown runner step.')
          return getCollectionRunOutput(current.runId, input.iteration, input.position)
        }
        case 'list_mock_servers': return page(filter(unwrap(await listMockServers(s.rootPath)).servers, input), input)
        case 'get_mock_server': {
          const current = await mock(string(input, 'serverId'))
          if (typeof input.routeId === 'string') {
            const route = current.routes.find((item) => item.id === input.routeId)
            if (!route) throw new Error('Unknown mock route.')
            if (typeof input.responseId === 'string') {
              const response = [route.defaultResponse, ...route.alternatives].find((item) => item.id === input.responseId)
              if (!response) throw new Error('Unknown mock response.')
              return response
            }
            return { ...route, alternatives: page(route.alternatives, input) }
          }
          const id = string(input, 'serverId')
          return { ...current, serverId: id, routes: page(current.routes, input), dirty: s.bridge.get('mock', id)?.read().dirty ?? false }
        }
        case 'create_mock_server': {
          const next = mergeResource({ id: crypto.randomUUID(), name: string(input, 'name'), port: 3001, corsEnabled: true, routes: [] }, input.server ?? {}) as MockServerDto
          next.id = crypto.randomUUID()
          next.name = string(input, 'name')
          unwrap(await saveMockServer(s.rootPath, next))
          mockChanged()
          return { serverId: next.id }
        }
        case 'update_mock_server': {
          const id = string(input, 'serverId')
          const controller = await mountedMock(id)
          const previous = controller.read().server!
          const patch = record(input.patch, 'patch')
          if ('id' in patch && patch.id !== id) throw new Error('The server id cannot change.')
          const next = mergeResource(previous, patch) as MockServerDto
          unwrap(await validateMockServer(next))
          const latestController = source().bridge.get('mock', id)
          if (!latestController || JSON.stringify(latestController.read().server) !== JSON.stringify(previous)) throw new Error('The mock draft changed while validating. Read it again.')
          latestController.replace(next)
          await settle()
          return { serverId: id, unsaved: true }
        }
        case 'save_mock_server': {
          const id = string(input, 'serverId')
          const controller = await mountedMock(id)
          await controller.save()
          if (inlineMock(id)) { await settle(); await source().flows.saveNow() }
          return { serverId: id, saved: true }
        }
        case 'open_mock_server': await mountedMock(string(input, 'serverId')); return { serverId: input.serverId }
        case 'delete_mock_server': {
          const id = string(input, 'serverId')
          if (inlineMock(id)) throw new Error('Remove inline mock blocks with update_flow; this tool deletes saved workspace mocks.')
          await mock(id)
          unwrap(await deleteMockServer(s.rootPath, id))
          for (const tab of s.openTabs.mockServerTabs.filter((tab) => tab.serverId === id)) s.openTabs.closeOpenTab(tab.id)
          mockChanged()
          return { deletedServerId: id }
        }
        case 'start_mock_server': case 'stop_mock_server': {
          const id = string(input, 'serverId')
          if (inlineMock(id)) throw new Error('Inline mocks are controlled by their flow execution.')
          await mock(id)
          if (s.bridge.get('mock', id)?.read().dirty) throw new Error('Save the mock draft before changing its running state.')
          unwrap(await (name === 'start_mock_server' ? startMockServer : stopMockServer)(s.rootPath, id))
          mockChanged()
          return { serverId: id, running: name === 'start_mock_server' }
        }
        case 'list_mock_calls': {
          const id = string(input, 'serverId')
          await mock(id)
          const pagination = page(Array.from({ length: 50 }), input)
          const entries = unwrap(await listMockCalls(id, pagination.offset, typeof input.limit === 'number' ? input.limit : 20))
          return { items: entries, nextOffset: entries.length === (input.limit ?? 20) ? pagination.offset + entries.length : null }
        }
        case 'clear_mock_calls': {
          const id = string(input, 'serverId')
          await mock(id)
          unwrap(await clearMockCalls(s.rootPath, id))
          window.dispatchEvent(new Event(MOCK_SERVERS_CHANGED_EVENT))
          return { serverId: id, cleared: true }
        }
        case 'get_collection': {
          const id = string(input, 'itemId')
          const current = findNode(s.collections.collections, id)
          if (!current) throw new Error('Unknown collection or folder.')
          return { id, name: current.name, authentication: current.authentication, variables: page(current.variables, input), folders: page(current.folders.map(({ id: folderId, name: label }) => ({ id: folderId, name: label })), input), requests: page(current.requests.map(({ id: requestId, name: label, protocol }) => ({ id: requestId, name: label, protocol })), input) }
        }
        case 'update_collection_item': {
          const id = string(input, 'itemId')
          const item = checkItem(id)
          await s.collections.commitCollections((current) => {
            let next = current
            if (input.name !== undefined) next = renameNode(next, id, string(input, 'name'))
            if (input.parentId !== undefined) {
              const target = string(input, 'parentId')
              if (!findNode(next, target) || current.some((node) => node.id === id) || descendantIds(current, id).includes(target) || target === id) throw new Error('Invalid move destination.')
              next = moveItems(next, [id], target)
            }
            if (input.authentication !== undefined) {
              if (!('authentication' in item)) throw new Error('Edit request authentication with update_request.')
              next = updateNodeAuthentication(next, id, mergeResource(item.authentication, input.authentication) as TreeNode['authentication'])
            }
            return next
          })
          return { itemId: id, updated: true }
        }
        case 'create_request': {
          // Saved straight into the collection: no tab opens (open_request shows it later).
          const parentId = string(input, 'parentId')
          if (!findNode(s.collections.collections, parentId)) throw new Error('parentId is not a collection or folder. Use search_collections.')
          const protocol = string(input, 'protocol')
          if (protocol !== 'rest' && protocol !== 'graphql' && protocol !== 'websocket') throw new Error("protocol must be 'rest', 'graphql' or 'websocket'.")
          const content = applyRequestPatch(emptyRequestContent(protocol), input)
          const requestName = string(input, 'name').trim()
          if (requestName === '') throw new Error('name is required.')
          const requestId = crypto.randomUUID()
          await s.collections.commitCollections((current) => insertRequest(current, parentId, { id: requestId, name: requestName, protocol, content }))
          return { requestId, name: requestName, parentId }
        }
        case 'duplicate_collection_item': {
          const id = string(input, 'itemId')
          const item = checkItem(id)
          const newId = crypto.randomUUID()
          const requestEdits = REQUEST_FIELDS.filter((field) => input[field] !== undefined)
          const parentId = typeof input.parentId === 'string' ? string(input, 'parentId') : null
          if (!('content' in item) && (requestEdits.length > 0 || parentId !== null)) throw new Error('Request fields and parentId only apply when duplicating a request.')
          if (parentId !== null && !findNode(s.collections.collections, parentId)) throw new Error('parentId is not a collection or folder. Use search_collections.')
          // The edits apply to the copy only; secrets written back as the mask keep the original's values.
          const content = 'content' in item && requestEdits.length > 0 ? applyRequestPatch(item.content, input) : null
          await s.collections.commitCollections((current) => {
            const label = typeof input.name === 'string' ? string(input, 'name') : `${item.name} copy`
            if (!('content' in item)) {
              const clone = { ...regenerateIds(item), id: newId, name: label }
              return insertFolder(current, findParentId(current, id) ?? null, clone)
            }
            let next = duplicateRequest(current, id, newId, label)
            if (content) next = updateRequestContent(next, newId, content)
            if (parentId !== null && parentId !== findParentId(next, newId)) next = moveItems(next, [newId], parentId)
            return next
          })
          return { itemId: newId, ...(requestEdits.length > 0 ? { changed: requestEdits } : {}), ...(parentId !== null ? { parentId } : {}) }
        }
        case 'delete_collection_item': {
          const id = string(input, 'itemId')
          checkItem(id)
          const removed = new Set([id, ...descendantIds(s.collections.collections, id)])
          await s.collections.commitCollections((current) => removeNode(current, id))
          for (const tab of s.workbench.tabs) if (tab.requestId && removed.has(tab.requestId)) s.openTabs.closeOpenTab(tab.id)
          return { deletedItemId: id }
        }
        case 'set_scope_variable': case 'delete_scope_variable': {
          const id = string(input, 'itemId')
          const node = findNode(s.collections.collections, id)
          if (!node) throw new Error('Unknown collection or folder.')
          const variableName = string(input, 'name')
          const variables = node.variables.filter((variable) => variable.name !== variableName)
          if (name === 'set_scope_variable') {
            const value = input.value
            if (typeof value !== 'string') throw new Error('value must be a string.')
            variables.push({ name: variableName, value: mergeResource(node.variables.find((variable) => variable.name === variableName)?.value, value) as string })
          }
          await s.collections.commitCollections((current) => updateNodeVariables(current, id, variables))
          return { itemId: id, name: variableName }
        }
        case 'create_environment': {
          const id = crypto.randomUUID()
          await s.environments.commitEnvironments((current) => ({ ...current, environments: [...current.environments, { id, name: string(input, 'name'), variables: [] }] }))
          return { environmentId: id }
        }
        case 'update_environment': {
          const id = string(input, 'environmentId')
          checkEnvironment(id)
          await s.environments.commitEnvironments((current) => ({ ...current, environments: current.environments.map((item) => item.id === id ? { ...item, name: string(input, 'name') } : item) }))
          return { environmentId: id }
        }
        case 'delete_environment': {
          const id = string(input, 'environmentId')
          checkEnvironment(id)
          await s.environments.commitEnvironments((current) => ({ environments: current.environments.filter((item) => item.id !== id), activeEnvironmentId: current.activeEnvironmentId === id ? null : current.activeEnvironmentId }))
          return { deletedEnvironmentId: id }
        }
        case 'delete_environment_variable': {
          const id = string(input, 'environmentId')
          const environment = checkEnvironment(id)
          const variableName = string(input, 'name')
          if (!environment.variables.some((variable) => variable.name === variableName)) throw new Error('Unknown variable.')
          await s.environments.commitEnvironments((current) => ({ ...current, environments: current.environments.map((item) => item.id === id ? { ...item, variables: item.variables.filter((variable) => variable.name !== variableName) } : item) }))
          return { environmentId: id, name: variableName }
        }
        default: throw new Error(`Unknown resource tool '${name}'.`)
      }
    }

    const host: AgentResourceHost = {
      cancelReads() {
        for (const queryId of inspections) void cancelFlowOutputQuery(queryId).catch(() => undefined)
        inspections.clear()
      },
      tabs: () => source().openTabs.descriptors.filter((tab) => tab.kind !== 'request').map((tab) => ({ tabId: tab.id, name: tab.label, kind: tab.kind, unsaved: tab.dirty, active: source().openTabs.activeOpenTab?.id === tab.id })),
      needsApproval(name, input) {
        if (name !== 'close_tab' || typeof input.tabId !== 'string') return false
        const s = source()
        const tab = s.openTabs.descriptors.find((tab) => tab.id === input.tabId)
        return tab?.dirty === true || s.bridge.get('runner', input.tabId)?.read().state.phase === 'running'
          || getFlowRunState(s.rootPath, input.tabId)?.isRunning === true || getLoadFlowRunState(s.rootPath, input.tabId)?.isRunning === true
      },
      async call(name, input) {
        const scope = source().rootPath
        const previousRunner = ['configure_runner', 'pick_runner_data_file', 'clear_runner_data_file'].includes(name) ? runner(string(input, 'runnerId')).read() : null
        const previousMock = name === 'update_mock_server' ? await mock(string(input, 'serverId')) : null
        const flowId = typeof input.flowId === 'string' ? input.flowId : ''
        let previousFlow: FlowDto | null = null
        if (FLOW_EDIT_TOOLS.includes(name)) try { previousFlow = flow(flowId) } catch { /* The tool reports the missing flow. */ }
        const mockKey = previousMock ? string(input, 'serverId') : ''
        let result: unknown
        try { result = await call(name, input) } catch (error) {
          return { content: boundedResource(redactResource({ error: error instanceof Error ? error.message : String(error) }, secrets(previousMock))), isError: true }
        }
        await settle()
        if (scope !== source().rootPath) return { content: 'The workspace changed before the operation finished.', isError: true }
        const expectedRunner = previousRunner ? JSON.stringify(runner(string(input, 'runnerId')).read()) : undefined
        const expectedMock = previousMock ? JSON.stringify(source().bridge.get('mock', mockKey)?.read()) : undefined
        const graph = (value: FlowDto) => JSON.stringify([value.name, value.nodes, value.edges, value.presentation])
        const restoreFlow = previousFlow
        const expectedFlow = restoreFlow ? graph(flow(flowId)) : undefined
        const revert = restoreFlow ? () => {
          let current: FlowDto
          try { current = flow(flowId) } catch { return false }
          const running = record(source().bridge.get('flow', flowId)?.status() ?? getFlowRunState(source().rootPath, flowId) ?? {}).isRunning === true
          if (scope !== source().rootPath || running || graph(current) !== expectedFlow) return false
          void saveFlow({ ...restoreFlow, updatedAtMs: Date.now() }).catch(() => undefined)
          return true
        } : previousRunner ? () => {
          const controller = source().bridge.get('runner', String(input.runnerId))
          if (scope !== source().rootPath || !controller || controller.read().state.phase === 'running' || JSON.stringify(controller.read()) !== expectedRunner) return false
          if (name === 'configure_runner') controller.configure(previousRunner)
          else controller.restoreDataFile?.(previousRunner.dataFile)
          return true
        } : previousMock ? () => {
          const controller = source().bridge.get('mock', mockKey)
          if (scope !== source().rootPath || !controller || !controller.read().dirty || JSON.stringify(controller.read()) !== expectedMock) return false
          controller.replace(previousMock)
          return true
        } : undefined
        return { content: boundedResource(redactResource(result, secrets(result))), isError: false, revert }
      },
      context() {
        const s = source()
        return [
          ...s.flows.flows.filter((item) => item.executionKind !== 'load' || FEATURE_FLAGS.loadTesting).map((item) => ({ kind: 'flow', id: item.id, label: item.name, summary: `${item.executionKind} flow; ${item.nodes.length} nodes. Read with get_flow.` })),
          ...(FEATURE_FLAGS.valueMonitors ? s.monitors.monitors.map((item) => ({ kind: 'monitor', id: item.id, label: item.name, summary: `Value monitor; ${item.rules.length} rules. Read with get_value_monitor.` })) : []),
          ...s.openTabs.runnerTabs.map((item) => ({ kind: 'runner', id: item.id, label: item.label, summary: 'Collection runner. Read with get_runner.' })),
          ...s.openTabs.mockServerTabs.map((item) => ({ kind: 'mock', id: item.serverId, label: item.label, summary: 'Mock server. Read with get_mock_server.' })),
        ]
      },
      summary(name, input) {
        const s = source()
        const label = s.flows.flows.find((item) => item.id === input.flowId)?.name
          ?? s.monitors.monitors.find((item) => item.id === input.monitorId)?.name
          ?? s.openTabs.runnerTabs.find((item) => item.id === input.runnerId)?.label
          ?? s.openTabs.mockServerTabs.find((item) => item.serverId === input.serverId)?.label
          ?? s.environments.environments.find((item) => item.id === input.environmentId)?.name
          ?? (typeof input.itemId === 'string' ? (findNode(s.collections.collections, input.itemId) ?? findRequest(s.collections.collections, input.itemId))?.name : undefined)
          ?? (typeof input.name === 'string' ? input.name : '')
        const preview = name === 'run_flow' && typeof input.flowId === 'string' ? loadPreviews.get(input.flowId)?.preview : undefined
        const changes = Object.keys(input).filter((key) => !['flowId', 'monitorId', 'runnerId', 'serverId', 'itemId', 'environmentId', 'name'].includes(key))
        const runnerState = typeof input.runnerId === 'string' ? s.bridge.get('runner', input.runnerId)?.read() : undefined
        const execution = name === 'run_runner' && runnerState ? { requests: runnerState.requestIds.length, iterations: runnerState.settings.iterations, delayMs: runnerState.settings.delayMs, dataFile: runnerState.dataFile.status } : undefined
        return boundedResource(redactResource({ name: label, ...(changes.length ? { changes } : {}), ...(execution ? { execution } : {}), ...(preview ? { preview } : {}) }, secrets()))
      },
      fingerprint(name, input) {
        if (!isResourceTool(name)) return undefined
        const s = source()
        const target = typeof input.flowId === 'string' ? flow(input.flowId)
          : typeof input.runnerId === 'string' ? (() => { const current = runner(input.runnerId as string).read(); return { requestIds: current.requestIds, settings: current.settings, dataFile: current.dataFile, runId: current.state.runId } })()
          : typeof input.serverId === 'string' ? s.bridge.get('mock', input.serverId)?.read()
          : typeof input.monitorId === 'string' ? monitor(input.monitorId)
          : typeof input.environmentId === 'string' ? checkEnvironment(input.environmentId)
          : typeof input.itemId === 'string' ? checkItem(input.itemId)
          : typeof input.parentId === 'string' ? findNode(s.collections.collections, input.parentId) : null
        const executionContext = name === 'run_flow' || name === 'run_runner' ? [s.environments.activeEnvironmentId, s.environments.environments, s.collections.collections] : undefined
        const drafts = name === 'delete_collection_item' || name === 'delete_flow' ? s.workbench.tabs.filter(isTabDirty).map((tab) => ({ id: tab.id, content: contentOf(tab) })) : undefined
        return JSON.stringify([s.rootPath, target, executionContext, drafts])
      },
    }
    return host
  }, [])
  useEffect(() => () => host.cancelReads?.(), [host, sources.rootPath])
  return host
}
