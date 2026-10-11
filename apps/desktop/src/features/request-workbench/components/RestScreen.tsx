import { useId } from 'react'
import alcyIcon from '../../../assets/alcy-icon.svg'
import type { TranslationKey } from '../../../shared/i18n/locales/pt-BR'
import { useLanguage } from '../../../shared/i18n/use-language'
import { ChevronRightIcon } from '../../../shared/ui/icons'
import './rest-screen.css'

interface RestScreenProps {
  onAddGraphqlRequest: () => void
  onAddRestRequest: () => void
}

const ACTIONS: Array<{
  protocol: 'graphql' | 'rest'
  badge: string
  titleKey: TranslationKey
  hintKey: TranslationKey
}> = [
  {
    protocol: 'graphql',
    badge: 'GQL',
    titleKey: 'workbench.openTabs.newGraphqlTabMenuItem',
    hintKey: 'collections.protocolGraphqlHint',
  },
  {
    protocol: 'rest',
    badge: 'HTTP',
    titleKey: 'workbench.openTabs.newRestTabMenuItem',
    hintKey: 'collections.protocolRestHint',
  },
]

export function RestScreen({ onAddGraphqlRequest, onAddRestRequest }: RestScreenProps) {
  const { t } = useLanguage()
  const id = useId()
  const titleId = `${id}-title`
  const handlers = { graphql: onAddGraphqlRequest, rest: onAddRestRequest }

  return (
    <div className="rw-rest-screen">
      <section className="rw-rest-screen-content" aria-labelledby={titleId}>
        <img src={alcyIcon} alt="" aria-hidden="true" className="rw-rest-screen-icon" />

        <h2 id={titleId} className="rw-rest-screen-title">
          {t('workbench.restScreen.title')}
        </h2>
        <p className="rw-rest-screen-description">{t('workbench.restScreen.description')}</p>

        <div className="rw-rest-screen-actions" role="group" aria-labelledby={titleId}>
          {ACTIONS.map((action) => (
            <button
              key={action.protocol}
              type="button"
              className="rw-rest-screen-action"
              aria-labelledby={`${id}-${action.protocol}-title`}
              aria-describedby={`${id}-${action.protocol}-hint`}
              onClick={handlers[action.protocol]}
            >
              <span className="rw-rest-screen-action-badge" aria-hidden="true">
                {action.badge}
              </span>
              <span className="rw-rest-screen-action-text">
                <span id={`${id}-${action.protocol}-title`} className="rw-rest-screen-action-title">
                  {t(action.titleKey)}
                </span>
                <span id={`${id}-${action.protocol}-hint`} className="rw-rest-screen-action-hint">
                  {t(action.hintKey)}
                </span>
              </span>
              <ChevronRightIcon size={14} className="rw-rest-screen-action-chevron" />
            </button>
          ))}
        </div>

        <p className="rw-rest-screen-footnote">{t('workbench.restScreen.collectionsHint')}</p>
      </section>
    </div>
  )
}
