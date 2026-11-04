import { useLanguage } from '../../shared/i18n/use-language'
import type { AgentDockPreview } from './use-agent-dock-drag'

/** While the panel is dragged: where it would land, over a layer that keeps the grabbing cursor. */
export function AgentDockOverlay({ preview }: { preview: AgentDockPreview | null }) {
  const { t } = useLanguage()
  if (!preview) return null
  return (
    <div className="agent-dock-drag-layer" aria-hidden="true">
      <div className="agent-dock-preview" data-dock={preview.dock} style={preview.rect}>
        {t(`agent.dock.${preview.dock}`)}
      </div>
    </div>
  )
}
