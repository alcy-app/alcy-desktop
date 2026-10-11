import { useLanguage } from '../../shared/i18n/use-language'
import { CheckIcon, DownloadIcon } from '../../shared/ui/icons'
import { useTooltip } from '../../shared/ui/use-tooltip'
import type { UpdatePhase } from './update-context'
import { downloadPercent } from './update-format'
import { useUpdates } from './use-updates'
import './updates.css'

interface UpdateStatusIndicatorProps {
  /** Abre as configurações na aba "Atualizações". */
  onOpen: () => void
}

type Translate = ReturnType<typeof useLanguage>['t']

/** Texto visível e descrição completa do item, ou `null` quando não há versão nova no fluxo. */
function describePhase(phase: UpdatePhase, t: Translate): { label: string; aria: string } | null {
  switch (phase.kind) {
    case 'available':
      return {
        label: phase.release.version,
        aria: t('updates.statusbar.available', { version: phase.release.version }),
      }
    case 'downloading': {
      const percent = downloadPercent(phase.downloaded, phase.total)
      return {
        label: percent !== null ? `${percent}%` : phase.release.version,
        aria: t('updates.statusbar.downloading', { version: phase.release.version }),
      }
    }
    case 'ready':
    case 'installing':
      return {
        label: t('updates.statusbar.readyLabel'),
        aria: t('updates.statusbar.ready', { version: phase.release.version }),
      }
    default:
      return null
  }
}

/** Item da barra inferior que só aparece quando há uma versão nova em algum ponto do fluxo. */
export function UpdateStatusIndicator({ onOpen }: UpdateStatusIndicatorProps) {
  const { t } = useLanguage()
  const { phase } = useUpdates()
  const status = describePhase(phase, t)
  const { triggerProps, tooltip } = useTooltip(status?.aria ?? '', { side: 'top' })

  if (!status) return null

  return (
    <>
      <button type="button" className="updates-statusbar" data-phase={phase.kind} aria-label={status.aria} {...triggerProps} onClick={onOpen}>
        {phase.kind === 'ready' || phase.kind === 'installing' ? <CheckIcon size={14} /> : <DownloadIcon size={14} />}
        <span>{status.label}</span>
      </button>
      {tooltip}
    </>
  )
}
