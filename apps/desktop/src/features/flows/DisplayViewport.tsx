import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'

/** The complete card is rendered in screen space, so this scrollport inherits its layout zoom. */
export function DisplayViewport({ children }: { children: ReactNode }) {
  const { t } = useLanguage()
  return <div className="flow-display-viewport nodrag nopan nowheel" role="region" aria-label={t('flows.studio.output')} tabIndex={0} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      {children}
    </div>
}
