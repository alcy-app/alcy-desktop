import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { FileChangeViewer } from './FileChangeViewer'
import type { VersionReviewTarget } from './VersionControlPanel'

interface VersionReviewProps {
  rootPath: string
  target: VersionReviewTarget
  onOpenItem?: () => void
}

export function VersionReview({ rootPath, target, onOpenItem }: VersionReviewProps) {
  const { t } = useLanguage()

  return <section className="vc-review" aria-label={t('vc.review.aria', { file: target.fileLabel })}>
    <header className="vc-review-header">
      <div><span className="vc-review-eyebrow">{t('vc.review.title')}</span><h2>{target.item?.label ?? target.fileLabel}</h2><p>{target.fileName}</p></div>
      <div className="vc-review-actions">{onOpenItem && <Button variant="ghost" onClick={onOpenItem}>{t('vc.review.openItem')}</Button>}<div className="vc-review-sides"><span>{t(target.direction === 'incoming' ? 'vc.review.local' : 'vc.review.remote')}</span><span>{t(target.direction === 'incoming' ? 'vc.review.remote' : 'vc.review.local')}</span></div></div>
    </header>
    <FileChangeViewer rootPath={rootPath} fileName={target.fileName} changes={target.changes} item={target.item} direction={target.direction} />
  </section>
}
