import { useMemo, useRef, useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Modal } from '../../shared/ui/Modal'
import { CheckIcon } from '../../shared/ui/icons'
import { FLOW_TEMPLATES, type FlowTemplateId } from './flow-templates'
import { FlowTemplatePreview } from './FlowTemplatePreview'
import './flow-templates.css'

interface FlowTemplatesModalProps {
  loadTestingEnabled: boolean
  onCreate: (templateId: FlowTemplateId) => void
  onCancel: () => void
}

export function FlowTemplatesModal({ loadTestingEnabled, onCreate, onCancel }: FlowTemplatesModalProps) {
  const { t } = useLanguage()
  const [selected, setSelected] = useState<FlowTemplateId>('blank')
  const confirmedRef = useRef(false)
  const cards = useMemo(() => FLOW_TEMPLATES
    .filter((template) => template.executionKind !== 'load' || loadTestingEnabled), [loadTestingEnabled])
  const create = () => {
    if (confirmedRef.current) return
    confirmedRef.current = true
    onCreate(selected)
  }

  return (
    <Modal title={t('flows.templates.menu')} closeAriaLabel={t('collections.closeModalAria')} onClose={onCancel} className="flow-templates-modal" onEnter={create}>
      {(requestClose) => <>
        <p className="ui-modal-description">{t('flows.templates.description')}</p>
        <div className="flow-templates-grid" role="group" aria-label={t('flows.templates.menu')}>
          {cards.map((card) => (
            <div key={card.id} className="flow-template-card" data-selected={selected === card.id}>
              <button type="button" className="flow-template-card-select" aria-pressed={selected === card.id}
                aria-label={t(card.nameKey)} aria-describedby={`flow-template-description-${card.id}`}
                autoFocus={card.id === 'blank'} onClick={() => setSelected(card.id)} />
              <div className="flow-template-card-art">
                <FlowTemplatePreview templateId={card.id} />
                <span className="flow-template-card-selection">{selected === card.id && <CheckIcon size={12} />}</span>
              </div>
              <span className="flow-template-card-content" aria-hidden="true">
                <span className="flow-template-card-badge">{t(card.executionKind === 'load' ? 'flows.templates.loadBadge' : 'flows.templates.standard')}</span>
                <span className="flow-template-card-title">{t(card.nameKey)}</span>
                <span className="flow-template-card-description" id={`flow-template-description-${card.id}`}>{t(card.descriptionKey)}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="ui-modal-actions">
          <Button variant="ghost" onClick={requestClose}>{t('common.cancel')}</Button>
          <Button onClick={create}>{t('flows.templates.create')}</Button>
        </div>
      </>}
    </Modal>
  )
}
