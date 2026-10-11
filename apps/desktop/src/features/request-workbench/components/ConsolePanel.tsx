import { useLanguage } from '../../../shared/i18n/use-language'
import { IconButton } from '../../../shared/ui/IconButton'
import { CloseIcon } from '../../../shared/ui/icons'
import { Tabs } from '../../../shared/ui/Tabs'
import { ConsoleLogView } from './ConsoleLogView'
import { HarRecorderView, type HarRecorderControls } from './HarRecorderView'
import type { ConsoleEntry } from '../use-console-state'
import './console-panel.css'

export type ConsolePanelTab = 'console' | 'recording'
export type ConsoleRecorderControls = HarRecorderControls

/** Mesma ordem dos botões da barra inferior; o painel sempre mostra todas as abas. */
const PANEL_TABS: ConsolePanelTab[] = ['recording', 'console']

interface ConsolePanelProps {
  entries: ConsoleEntry[]
  onClear: () => void
  onRemove: (id: string) => void
  onClose: () => void
  tab: ConsolePanelTab
  onTabChange: (tab: ConsolePanelTab) => void
  recorder: ConsoleRecorderControls
}

export function ConsolePanel({
  entries,
  onClear,
  onRemove,
  onClose,
  tab,
  onTabChange,
  recorder,
}: ConsolePanelProps) {
  const { t } = useLanguage()

  return (
    <div className="console-panel">
      <header className="console-panel-header">
        <Tabs
          tabs={PANEL_TABS.map((tabId) => ({
            id: tabId,
            label:
              tabId === 'recording' ? (
                <span className="console-panel-tab-label">
                  {recorder.recording && <span className="console-panel-rec-dot" aria-hidden="true" />}
                  {t('devConsole.recorderTab')}
                </span>
              ) : (
                t('devConsole.title')
              ),
          }))}
          activeTab={tab}
          onChange={onTabChange}
          ariaLabel={t('devConsole.toolsLabel')}
          idPrefix="console-panel-"
          className="console-panel-tabs"
        />
        <IconButton icon={<CloseIcon size={12} />} label={t('devConsole.closeAria')} onClick={onClose} />
      </header>

      <div
        id="tabpanel-console-panel-recording"
        role="tabpanel"
        aria-labelledby="tab-console-panel-recording"
        className="console-panel-content ui-tabpanel-motion"
        hidden={tab !== 'recording'}
      >
        <HarRecorderView recorder={recorder} />
      </div>
      <div
        id="tabpanel-console-panel-console"
        role="tabpanel"
        aria-labelledby="tab-console-panel-console"
        className="console-panel-content ui-tabpanel-motion"
        hidden={tab !== 'console'}
      >
        <ConsoleLogView entries={entries} onClear={onClear} onRemove={onRemove} />
      </div>
    </div>
  )
}
