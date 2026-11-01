import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { useLanguage } from '../../shared/i18n/use-language'
import { MenuItem } from '../../shared/ui/Menu'
import { mentionInChat, type AgentMentionRequest } from './agent-mention-bridge'

/** "Mention in chat" for an item's menu: opens the agent chat with the item mentioned in the message. */
export function MentionInChatMenuItem({ item, onDone }: { item: AgentMentionRequest; onDone: () => void }) {
  const { t } = useLanguage()
  if (!FEATURE_FLAGS.agent) return null
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
