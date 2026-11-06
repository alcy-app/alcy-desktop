import { useEffect, useRef, useState } from 'react'
import { cancelGitlabOperation } from '../../bindings/cancel-gitlab-operation'
import type { StructuredFileChangesDto } from '../../bindings/gitlab-types'
import { getGitCommitChanges, getGitHistory, restoreGitFile, type GitCommitDto } from '../../bindings/local-git'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { ChevronDownIcon, ChevronRightIcon } from '../../shared/ui/icons'
import { formatDateTime, formatRelativeTime } from '../documents/document-format'
import { FILE_LABELS, itemKindLabelKey } from './file-labels'
import type { VersionControl } from './use-version-control'

interface Page {
  /** `rootPath:reloadKey` the page was loaded for. */
  key: string
  commits: GitCommitDto[]
  nextOffset: number | null
}

interface GitHistoryProps {
  rootPath: string
  vc: VersionControl
  /** Changes when the branch may have moved (commit, merge, switch, sync). */
  reloadKey: string
}

/**
 * History of the current branch, newest first, collapsed until opened. Pages
 * of up to 50 commits come from the backend on demand; a commit opens to its
 * files, each file to its changed items, with "restore this version".
 */
export function GitHistory({ rootPath, vc, reloadKey }: GitHistoryProps) {
  const { t, language } = useLanguage()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<Page | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const moreOperationRef = useRef<string | null>(null)
  const key = `${rootPath}:${reloadKey}`
  const current = page?.key === key ? page : null

  // First page: loaded when opened, and again whenever the branch may have moved.
  useEffect(() => {
    if (!open || current) return
    const operationId = crypto.randomUUID()
    let active = true
    void getGitHistory(rootPath, operationId, 0).then((result) => {
      if (!active) return
      if (result.ok) {
        setFailure(null)
        setPage({ key, commits: result.value.commits, nextOffset: result.value.nextOffset })
      } else if (result.error.kind !== 'cancelled') {
        setFailure({ key, message: gitlabErrorMessage(result.error, t) })
      }
    })
    return () => {
      active = false
      void cancelGitlabOperation(operationId)
    }
  }, [current, key, open, rootPath, t])

  useEffect(() => () => {
    if (moreOperationRef.current) void cancelGitlabOperation(moreOperationRef.current)
  }, [])

  const loadMore = async (from: Page) => {
    if (from.nextOffset === null) return
    const operationId = crypto.randomUUID()
    moreOperationRef.current = operationId
    setLoadingMore(true)
    const result = await getGitHistory(rootPath, operationId, from.nextOffset)
    if (moreOperationRef.current !== operationId) return
    moreOperationRef.current = null
    setLoadingMore(false)
    if (result.ok) setPage({ key: from.key, commits: [...from.commits, ...result.value.commits], nextOffset: result.value.nextOffset })
    else if (result.error.kind !== 'cancelled') setFailure({ key: from.key, message: gitlabErrorMessage(result.error, t) })
  }

  const error = failure?.key === key ? failure.message : null
  const loading = open && !current && !error

  return <section className="vc-change-section vc-history">
    <header className="vc-section-header">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}<h3>{t('vc.history.title')}</h3>
      </button>
    </header>
    {open && <>
      {error && <InlineAlert>{error}</InlineAlert>}
      {loading && <p className="vc-section-empty" role="status">{t('vc.history.loading')}</p>}
      {current && current.commits.length === 0 && <p className="vc-section-empty">{t('vc.history.empty')}</p>}
      {current && current.commits.length > 0 && <ol className="vc-history-list" aria-label={t('vc.history.title')}>
        {current.commits.map((commit) => {
          const at = commit.time * 1000
          const isOpen = expanded === commit.id
          return <li key={commit.id} className="vc-history-commit">
            <button type="button" className="vc-history-toggle" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : commit.id)}>
              <span className="vc-history-summary">
                {commit.merge && <span className="vc-history-merge">{t('vc.history.merge')}</span>}
                {commit.summary || t('vc.history.noMessage')}
              </span>
              <small className="vc-history-meta">
                <span title={commit.authorEmail}>{commit.authorName}</span>
                {' · '}
                <time dateTime={new Date(at).toISOString()} title={formatDateTime(at, language)}>{formatRelativeTime(at, language)}</time>
                {' · '}
                <code>{commit.id.slice(0, 7)}</code>
              </small>
            </button>
            {isOpen && <ul className="vc-history-files">
              {commit.files.length === 0 && <li className="vc-muted">{t('vc.history.noFiles')}</li>}
              {commit.files.map((file) => <CommitFile key={file} rootPath={rootPath} vc={vc} commit={commit.id} file={file} />)}
            </ul>}
          </li>
        })}
      </ol>}
      {current && current.nextOffset !== null && <Button variant="ghost" isLoading={loadingMore} onClick={() => void loadMore(current)}>{t('vc.history.loadMore')}</Button>}
    </>}
  </section>
}

function CommitFile({ rootPath, vc, commit, file }: { rootPath: string; vc: VersionControl; commit: string; file: string }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [changes, setChanges] = useState<{ value: StructuredFileChangesDto | null; error: string | null } | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const label = FILE_LABELS[file] ?? file

  useEffect(() => {
    if (!open || changes) return
    let active = true
    void getGitCommitChanges(rootPath, commit, file).then((result) => {
      if (!active) return
      setChanges(result.ok ? { value: result.value, error: null } : { value: null, error: gitlabErrorMessage(result.error, t) })
    })
    return () => {
      active = false
    }
  }, [changes, commit, file, open, rootPath, t])

  const restore = async () => {
    setConfirmRestore(false)
    await vc.runGit(
      () => restoreGitFile(rootPath, commit, file),
      (value) => ({ files: value.files, notice: t('vc.history.restored', { file: label }) }),
    )
  }

  return <li className="vc-history-file">
    <div className="vc-history-file-row">
      <button type="button" className="vc-history-file-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}<span>{label}</span>
      </button>
      <button type="button" className="vc-section-action" disabled={vc.busy !== null} onClick={() => setConfirmRestore(true)}>{t('vc.history.restore')}</button>
    </div>
    {open && changes === null && <p className="vc-muted" role="status">{t('vc.history.loading')}</p>}
    {open && changes?.error && <InlineAlert>{changes.error}</InlineAlert>}
    {open && changes?.value && (changes.value.items.length === 0
      ? <p className="vc-muted">{t('vc.history.wholeFile')}</p>
      : <ul className="vc-history-items">{changes.value.items.map((item) => <li key={item.id}>
        <span>{item.label}</span>
        <small>{t(itemKindLabelKey(item.itemKind))} · {t(`vc.change.${item.changeKind}`)}</small>
      </li>)}</ul>)}
    {confirmRestore && <ConfirmDialog
      title={t('vc.history.restore')}
      description={t('vc.history.restoreConfirm', { file: label })}
      confirmLabel={t('vc.history.restore')}
      cancelLabel={t('gitlab.cancel')}
      closeAriaLabel={t('gitlab.cancel')}
      onCancel={() => setConfirmRestore(false)}
      onConfirm={() => void restore()}
    />}
  </li>
}
