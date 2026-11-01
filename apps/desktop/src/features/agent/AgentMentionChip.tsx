import { AtIcon } from '../../shared/ui/icons'
import type { AgentContextKind } from './agent-context'
import { CONTEXT_ICONS } from './agent-context-icons'

/**
 * An `@label` mention: the `@` gives way to the item's icon and the text keeps its width,
 * so the composer can draw it right behind its own text.
 */
export function AgentMentionChip({ kind, text }: { kind: AgentContextKind; text: string }) {
  const Icon = CONTEXT_ICONS[kind] ?? AtIcon
  return (
    <span className="agent-mention" data-kind={kind}>
      <span className="agent-mention-at">{text.slice(0, 1)}<Icon size={12} /></span>
      {text.slice(1)}
    </span>
  )
}
