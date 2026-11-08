import { useEffect, useState } from 'react'
import { cancelVersionControlOperation } from '../../bindings/cancel-version-control-operation'
import { getStructuredFileChanges } from '../../bindings/get-structured-file-changes'
import { previewPullChanges } from '../../bindings/preview-pull-changes'
import type { VersionControlCommandError, StructuredFileChangesDto } from '../../bindings/version-control-types'
import { versionControlErrorMessage } from '../../shared/version-control-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { EmptyState } from '../../shared/ui/EmptyState'
import { GitPullIcon, Spinner } from '../../shared/ui/icons'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Modal } from '../../shared/ui/Modal'
import { FileChangeViewer } from './FileChangeViewer'
import { FILE_LABELS } from './file-labels'
import type { VersionControl } from './use-version-control'

interface PullReviewModalProps {
  rootPath: string
  vc: VersionControl
  onClose: () => void
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; error: VersionControlCommandError }
  | { status: 'ready'; incoming: string[]; conflicts: string[] }

/** Revisa o que uma atualização traria do remoto (com diff) antes de aplicar. */
export function PullReviewModal({ rootPath, vc, onClose }: PullReviewModalProps) {
  const { t } = useLanguage()
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' })
  const [details, setDetails] = useState<Record<string, StructuredFileChangesDto>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<VersionControlCommandError | null>(null)

  useEffect(() => {
    let cancelled = false
    const operationId = crypto.randomUUID()
    void previewPullChanges(rootPath, operationId).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setPreview({ status: 'ready', incoming: result.value.incoming, conflicts: result.value.conflicts })
        setSelected(result.value.incoming[0] ?? null)
      } else {
        setPreview({ status: 'error', error: result.error })
      }
    })
    return () => {
      cancelled = true
      void cancelVersionControlOperation(operationId)
    }
  }, [rootPath])

  const incoming = preview.status === 'ready' ? preview.incoming : []

  useEffect(() => {
    if (incoming.length === 0) return
    const operationIds: string[] = []
    let cancelled = false
    void Promise.all(incoming.map(async (fileName) => {
      const operationId = crypto.randomUUID()
      operationIds.push(operationId)
      const result = await getStructuredFileChanges(rootPath, operationId, fileName, vc.files.find((file) => file.name === fileName)?.remoteRevision, vc.files.find((file) => file.name === fileName)?.localRevision)
      if (cancelled || !result.ok) return
      setDetails((current) => ({ ...current, [fileName]: result.value }))
    }))
    return () => {
      cancelled = true
      operationIds.forEach((id) => void cancelVersionControlOperation(id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, incoming.join(',')])

  return <Modal title={t('vc.pull.review.title')} closeAriaLabel={t('vc.pull.review.cancel')} onClose={onClose} className="vc-modal vc-pull-review">
    {(requestClose) => {
      const apply = async () => {
        setApplyError(null)
        const result = await vc.pull()
        if (result.ok) requestClose()
        else setApplyError(result.error)
      }
      return <>
      {preview.status === 'loading' && <p className="vc-diff-message" role="status"><Spinner size={14} /> {t('vc.pull.review.loading')}</p>}
      {preview.status === 'error' && <InlineAlert>{versionControlErrorMessage(preview.error, t)}</InlineAlert>}
      {preview.status === 'ready' && preview.incoming.length === 0 && preview.conflicts.length === 0 && (
        <EmptyState icon={<GitPullIcon size={28} />} title={t('vc.pull.review.empty')} />
      )}
      {preview.status === 'ready' && (preview.incoming.length > 0 || preview.conflicts.length > 0) && (
        <div className="vc-pull-review-body">
          {preview.incoming.length > 0 && (
            <div className="vc-pull-review-files" role="listbox" aria-label={t('vc.pull.review.filesAria')}>
              {preview.incoming.map((fileName) => (
                <button
                  key={fileName}
                  type="button"
                  role="option"
                  aria-selected={selected === fileName}
                  className="vc-file-button"
                  onClick={() => setSelected(fileName)}
                >
                  {FILE_LABELS[fileName] ?? fileName}
                </button>
              ))}
            </div>
          )}
          <div className="vc-pull-review-viewer">
            {selected && details[selected] ? (
              <FileChangeViewer rootPath={rootPath} fileName={selected} changes={details[selected]} item={null} direction="incoming" />
            ) : selected ? (
              <p className="vc-diff-message" role="status"><Spinner size={14} /> {t('vc.diff.loading')}</p>
            ) : null}
          </div>
        </div>
      )}
      {preview.status === 'ready' && preview.conflicts.length > 0 && (
        <p className="vc-pull-review-conflicts-note">{t('vc.pull.review.conflictsNote', { count: preview.conflicts.length })}</p>
      )}
      {applyError && <InlineAlert>{versionControlErrorMessage(applyError, t)}</InlineAlert>}
      <div className="vc-actions">
        <Button variant="ghost" onClick={requestClose}>{t('vc.pull.review.cancel')}</Button>
        {preview.status === 'ready' && preview.incoming.length > 0 && (
          <Button isLoading={vc.busy === 'pull'} disabled={vc.busy !== null} onClick={() => void apply()}>
            {t('vc.pull.review.apply')}
          </Button>
        )}
      </div>
      </>
    }}
  </Modal>
}
