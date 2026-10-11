import type { ReactNode } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { BranchIcon, ChevronRightIcon, GlobeIcon } from '../../../shared/ui/icons'
import type { WorkbenchProtocol } from '../request-workbench.types'

interface RequestBreadcrumbProps {
  segments: string[]
  protocol: WorkbenchProtocol
  /** Ações alinhadas à direita da linha (ex.: compartilhar), acima do botão Enviar. */
  actions?: ReactNode
}

export function RequestBreadcrumb({ segments, protocol, actions }: RequestBreadcrumbProps) {
  const { t } = useLanguage()

  return (
    <div className="rw-request-breadcrumb">
      <nav className="rw-request-breadcrumb-nav" aria-label={t('workbench.breadcrumb.ariaLabel')}>
        <span className={`rw-request-breadcrumb-icon rw-request-breadcrumb-icon--${protocol}`} aria-hidden="true">
          {protocol === 'graphql' ? <BranchIcon size={12} /> : <GlobeIcon size={12} />}
        </span>
        <ol className="rw-request-breadcrumb-list">
          {segments.map((segment, index) => {
            const current = index === segments.length - 1
            return (
              <li key={`${index}:${segment}`} className="rw-request-breadcrumb-item">
                {index > 0 && <ChevronRightIcon size={9} className="rw-request-breadcrumb-separator" />}
                <span className="rw-request-breadcrumb-label" aria-current={current ? 'page' : undefined} title={segment}>
                  {segment}
                </span>
              </li>
            )
          })}
        </ol>
      </nav>
      {actions && <div className="rw-request-breadcrumb-actions">{actions}</div>}
    </div>
  )
}
