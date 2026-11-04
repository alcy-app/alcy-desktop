import { AtIcon, FlowIcon, FolderIcon, GlobeIcon, MockServerIcon, MonitorIcon, PanelBottomIcon, PanelRightIcon, RunnerIcon, SelectionIcon, VariablesIcon } from '../../shared/ui/icons'
import type { AgentContextKind } from './agent-context'

/** Icon of each kind of item the agent can be given as context. */
export const CONTEXT_ICONS: Record<AgentContextKind, typeof AtIcon> = {
  document: PanelRightIcon,
  response: PanelBottomIcon,
  tab: PanelRightIcon,
  request: GlobeIcon,
  collection: FolderIcon,
  folder: FolderIcon,
  field: PanelBottomIcon,
  environment: VariablesIcon,
  selection: SelectionIcon,
  flow: FlowIcon,
  monitor: MonitorIcon,
  runner: RunnerIcon,
  mock: MockServerIcon,
  quote: AtIcon,
}
