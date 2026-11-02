import type { LoadFlowPreviewDto } from '../../bindings/preview-load-flow'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Modal } from '../../shared/ui/Modal'
import { ClockIcon, FlowIcon, GlobeIcon, LoadTestIcon, PlayIcon } from '../../shared/ui/icons'
import { VirtualizedList } from '../request-workbench/components/VirtualizedList'
import './load-run-confirmation-modal.css'

interface LoadRunConfirmationModalProps {
  preview: LoadFlowPreviewDto
  onClose: () => void
  onConfirm: () => void
}

export function LoadRunConfirmationModal({ preview, onClose, onConfirm }: LoadRunConfirmationModalProps) {
  const { t } = useLanguage()

  return (
    <Modal
      title={t('flows.loadRun.confirmTitle')}
      closeAriaLabel={t('flows.loadRun.confirmCloseAria')}
      onClose={onClose}
      onEnter={onConfirm}
      className="load-run-confirmation-modal"
    >
      {(requestClose) => (
        <>
          <span className="load-run-confirmation-icon" aria-hidden="true"><LoadTestIcon size={24} /></span>
          <p className="ui-modal-description load-run-confirmation-description">{t('flows.loadRun.confirmDescription')}</p>

          <dl className="load-run-confirmation-metrics">
            <div>
              <dt><LoadTestIcon />{t('flows.loadRun.peakVus')}</dt>
              <dd>{preview.peakVus}</dd>
            </div>
            <div>
              <dt><ClockIcon />{t('flows.loadRun.duration')}</dt>
              <dd className="load-run-confirmation-duration">{preview.durationMs === null ? t('flows.loadRun.durationOpen') : `${preview.durationMs} ms`}</dd>
            </div>
            {preview.peakArrivalRatePerSecond !== null && (
              <div>
                <dt>{t('flows.loadRun.peakRate')}</dt>
                <dd>{preview.peakArrivalRatePerSecond.toFixed(2)} <span>{t('flows.loadRun.requestsPerSecond')}</span></dd>
              </div>
            )}
          </dl>

          <section className="load-run-confirmation-section" aria-label={t('flows.loadRun.destinations')}>
            <h3>{t('flows.loadRun.destinations')}<span className="load-run-confirmation-count">{preview.destinations.length}</span></h3>
            {preview.destinations.length === 0 ? <p className="ui-modal-description">{t('common.empty')}</p> : (
              <VirtualizedList
                className="load-run-confirmation-viewport"
                ariaLabel={t('flows.loadRun.destinations')}
                items={preview.destinations}
                getKey={(destination) => destination}
                estimatedRowHeight={44}
                renderItem={(destination) => (
                  <div className="load-run-confirmation-target"><GlobeIcon size={16} /><span>{destination}</span></div>
                )}
              />
            )}
          </section>

          <section className="load-run-confirmation-section" aria-label={t('flows.loadRun.scenarios')}>
            <h3>{t('flows.loadRun.scenarios')}<span className="load-run-confirmation-count">{preview.scenarios.length}</span></h3>
            {preview.scenarios.length === 0 ? <p className="ui-modal-description">{t('common.empty')}</p> : (
              <VirtualizedList
                className="load-run-confirmation-viewport"
                ariaLabel={t('flows.loadRun.scenarios')}
                items={preview.scenarios}
                getKey={(scenario) => scenario.nodeId}
                estimatedRowHeight={76}
                renderItem={(scenario) => (
                  <div className="load-run-confirmation-scenario">
                    <span className="load-run-confirmation-scenario-icon"><FlowIcon size={16} /></span>
                    <div className="load-run-confirmation-scenario-content">
                      <strong>{scenario.label}</strong>
                      <div className="load-run-confirmation-scenario-metrics">
                        <span>{scenario.peakVus} {scenario.peakVus === 1 ? t('flows.loadRun.vu') : 'VUs'}</span>
                        <span>{scenario.requestCount} {t(scenario.requestCount === 1 ? 'flows.loadRun.request' : 'flows.loadRun.requests').toLocaleLowerCase()}</span>
                        {scenario.peakArrivalRatePerSecond !== null && <span>{scenario.peakArrivalRatePerSecond.toFixed(2)} {t('flows.loadRun.requestsPerSecond')}</span>}
                      </div>
                    </div>
                  </div>
                )}
              />
            )}
          </section>

          <div className="ui-modal-actions load-run-confirmation-actions">
            <Button variant="ghost" size="md" onClick={requestClose}>{t('common.cancel')}</Button>
            <Button variant="primary" size="md" onClick={onConfirm}><PlayIcon size={12} />{t('flows.loadRun.confirmButton')}</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
