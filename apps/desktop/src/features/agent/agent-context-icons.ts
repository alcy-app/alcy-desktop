import { AtIcon, FolderIcon, GlobeIcon, PanelBottomIcon, PanelRightIcon, SelectionIcon, SendIcon, VariablesIcon } from '../../shared/ui/icons'
import type { AgentContextKind } from './agent-context'

/** Icon of each kind of item the agent can be given as context. */
export const CONTEXT_ICONS: Record<AgentContextKind, typeof AtIcon> = {
  response: PanelBottomIcon,
  tab: PanelRightIcon,
  request: GlobeIcon,
  environment: VariablesIcon,
  selection: SelectionIcon,
  flow: FolderIcon,
  monitor: SelectionIcon,
  runner: SendIcon,
  mock: GlobeIcon,
  quote: AtIcon,
}
