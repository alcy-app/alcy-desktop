import { useLanguage } from '../../shared/i18n/use-language'
import { MenuItem } from '../../shared/ui/Menu'
import { mentionInChat, type AgentMentionRequest } from './agent-mention-bridge'
import { useAgentPreferences } from './use-agent-preferences'

/** "Mention in chat" for an item's menu: opens the agent chat with the item mentioned in the message. */
export function MentionInChatMenuItem({ item, onDone }: { item: AgentMentionRequest; onDone: () => void }) {
  const { t } = useLanguage()
  const { contextOptionsEnabled } = useAgentPreferences()
  if (!contextOptionsEnabled) return null
  return (
    <MenuItem
      label={t('agent.mention.menuItem')}
      onSelect={() => {
        onDone()
        mentionInChat(item)
      }}
    />
  )
}
