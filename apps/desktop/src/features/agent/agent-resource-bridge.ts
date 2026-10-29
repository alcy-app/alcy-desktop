import { useLayoutEffect } from 'react'
import type { FlowDto } from '../../bindings/list-flows'
import type { MockServerDto } from '../../bindings/mock-servers'
import type { RunnerSettings } from '../collection-runner/runner-settings'
import type { CollectionRunState } from '../collection-runner/collection-run-state'
import type { DataFileState } from '../collection-runner/RunnerConfigView'

export interface FlowAgentController {
  read(): FlowDto
  replace(flow: FlowDto): void
  renameNode(previous: string, next: string): void
  status(): unknown
  run(): Promise<unknown>
  cancel(): void
}

export interface RunnerAgentConfiguration {
  requestIds: string[]
  settings: RunnerSettings
}

export interface RunnerAgentController {
  read(): RunnerAgentConfiguration & { dataFile: DataFileState; state: CollectionRunState; error: unknown }
  configure(configuration: RunnerAgentConfiguration): void
  pickDataFile(): Promise<void>
  clearDataFile(): void
  restoreDataFile?(value: DataFileState): void
  run(): Promise<unknown>
  cancel(): void
}

export interface MockAgentController {
  read(): { server: MockServerDto | null; dirty: boolean; busy: boolean }
  replace(server: MockServerDto): void
  save(): Promise<void>
}

interface Controllers {
  flow: FlowAgentController
  runner: RunnerAgentController
  mock: MockAgentController
}

/** One workbench owns one bridge. Controllers only expose actions of mounted editors. */
export class AgentResourceBridge {
  readonly rootPath: string
  constructor(rootPath: string) { this.rootPath = rootPath }
  private controllers: { [K in keyof Controllers]: Map<string, Controllers[K]> } = {
    flow: new Map(), runner: new Map(), mock: new Map(),
  }

  get<K extends keyof Controllers>(kind: K, id: string): Controllers[K] | undefined {
    return this.controllers[kind].get(id)
  }

  register<K extends keyof Controllers>(kind: K, id: string, controller: Controllers[K]): () => void {
    this.controllers[kind].set(id, controller)
    return () => {
      if (this.controllers[kind].get(id) === controller) this.controllers[kind].delete(id)
    }
  }
}

export function useAgentResourceController<K extends keyof Controllers>(bridge: AgentResourceBridge | undefined, kind: K, id: string, controller: Controllers[K]) {
  useLayoutEffect(() => bridge?.register(kind, id, controller), [bridge, kind, id, controller])
}
