import type { ReactNode } from 'react'
import type { LoadTestImportAnalysisDto } from '../../../bindings/load-test-import'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { Button } from '../../../shared/ui/Button'
import { GlobeIcon, ImportIcon, VariablesIcon } from '../../../shared/ui/icons'
import { Modal } from '../../../shared/ui/Modal'
import { VirtualizedList } from './VirtualizedList'
import './import-collection-modal.css'
import './import-load-test-modal.css'

interface ImportLoadTestModalProps {
  sourcePath: string
  preview: LoadTestImportAnalysisDto
  onConfirm: () => void
  onClose: () => void
}

function ReviewList({ label, items, icon, emptyLabel }: { label: string; items: string[]; icon: ReactNode; emptyLabel: string }) {
  return (
    <section className="load-import-section" aria-label={label}>
      <h4>{label}<Badge>{items.length}</Badge></h4>
      {items.length === 0 ? <p className="ui-modal-description">{emptyLabel}</p> : (
        <VirtualizedList
          className="load-import-list"
          ariaLabel={label}
          items={items}
          getKey={(item) => item}
          estimatedRowHeight={38}
          renderItem={(item) => <div className="load-import-list-item">{icon}<span>{item}</span></div>}
        />
      )}
    </section>
  )
}

export function ImportLoadTestModal({ sourcePath, preview, onConfirm, onClose }: ImportLoadTestModalProps) {
  const { t } = useLanguage()
  const sourceName = sourcePath.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? sourcePath
  const assets = preview.assets.map((asset) => asset === 'source' ? t('flows.importLoadTestSourceAsset') : asset)

  return (
    <Modal
      title={t('flows.importLoadTestAria')}
      closeAriaLabel={t('common.close')}
      onClose={onClose}
      onEnter={onConfirm}
      className="ui-modal--form ui-modal--wide ui-modal--top import-modal import-modal--review load-import-modal"
    >
      {(requestClose) => (
        <div className="import-modal-review">
          <header className="import-modal-review-header">
            <h3 className="import-modal-review-title">{t('collections.importReviewTitle')}</h3>
            <p className="ui-modal-description">{t('flows.importLoadTestDescription')}</p>
          </header>

          <div className="import-modal-cards">
            <article className="import-modal-card">
              <header className="import-modal-card-header load-import-card-header">
                <ImportIcon size={18} />
                <div className="import-modal-card-heading">
                  <strong title={preview.flow.name || sourceName}>{preview.flow.name || sourceName}</strong>
                  <div className="import-modal-card-meta">
                    <span className="import-modal-format">{preview.format === 'k6' ? 'k6' : 'JMeter'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="import-modal-card-source" title={sourceName}>{sourceName}</span>
                  </div>
                  {preview.requiredVariables.length > 0 && <Badge tone="warning" className="load-import-variable-badge">{t('flows.importLoadTestVariablesTitle')} · {preview.requiredVariables.length}</Badge>}
                </div>
              </header>

              <div className="load-import-card-body">
                <dl className="load-import-summary">
                  <div><dt>{t('flows.canvas.paletteBlocksCategory')}</dt><dd>{preview.blocks}</dd></div>
                  <div><dt>{t('flows.loadRun.destinations')}</dt><dd>{preview.destinations.length}</dd></div>
                  <div><dt>{t('flows.importLoadTestAssets')}</dt><dd>{preview.assets.length}</dd></div>
                </dl>

                <ReviewList label={t('flows.loadRun.destinations')} items={preview.destinations} icon={<GlobeIcon size={14} />} emptyLabel={t('flows.importLoadTestNoDestination')} />

                <div className="load-import-assets">
                  <ReviewList label={t('flows.importLoadTestAssets')} items={assets} icon={<ImportIcon size={14} />} emptyLabel={t('common.empty')} />
                  {assets.length > 0 && <p className="ui-modal-description">{t('flows.importLoadTestAssetsHint')}</p>}
                </div>

                {preview.requiredVariables.length > 0 && (
                  <aside className="load-import-variables">
                    <ReviewList label={t('flows.importLoadTestVariablesTitle')} items={preview.requiredVariables} icon={<VariablesIcon size={14} />} emptyLabel={t('common.empty')} />
                    <p className="ui-modal-description">{t('flows.importLoadTestVariablesHint')}</p>
                  </aside>
                )}
              </div>
            </article>
          </div>

          <div className="ui-modal-actions import-modal-review-actions">
            <Button variant="ghost" onClick={requestClose}>{t('common.cancel')}</Button>
            <Button onClick={onConfirm}><ImportIcon size={14} />{t('flows.importLoadTestConfirmButton')}</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
