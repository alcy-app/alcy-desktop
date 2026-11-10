import { useEffect, useMemo, useRef, useState } from 'react'
import { cancelVersionControlOperation } from '../../bindings/cancel-version-control-operation'
import type { StructuredFileChangesDto } from '../../bindings/version-control-types'
import { getGitCommitChanges, getGitHistory, restoreGitFile, type GitCommitDto, type GitStateDto } from '../../bindings/local-git'
import { versionControlErrorMessage } from '../../shared/version-control-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { ChevronDownIcon, ChevronRightIcon } from '../../shared/ui/icons'
import { formatDateTime, formatRelativeTime } from '../documents/document-format'
import { FILE_LABELS, itemKindLabelKey } from './file-labels'
import { layoutGraph, type GraphRow } from './git-graph'
import { GitRemoteActions } from './GitWorkspace'
import type { VersionControl } from './use-version-control'
import type { VersionReviewTarget } from './VersionControlPanel'

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
  state: GitStateDto
  /** Opens what an item changed; without it the items are only listed. */
  onReview?: (target: VersionReviewTarget) => void
}

const LANE_WIDTH = 12
const ROW_HEIGHT = 24
/** Lanes beyond this are cut off: the commit text stays readable. */
const MAX_LANES = 8
const LANE_COLORS = 5

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => LANE_WIDTH * lane + LANE_WIDTH / 2
  const middle = ROW_HEIGHT / 2
  return <svg className="vc-graph-cell" width={width * LANE_WIDTH} height={ROW_HEIGHT} aria-hidden="true">
    {row.lines.map((line, index) => {
      const [y1, y2] = line.half === 'top' ? [0, middle] : [middle, ROW_HEIGHT]
      return <path key={index} className={`vc-graph-lane-${line.colorLane % LANE_COLORS}`} d={`M${x(line.fromLane)} ${y1} C${x(line.fromLane)} ${(y1 + y2) / 2} ${x(line.toLane)} ${(y1 + y2) / 2} ${x(line.toLane)} ${y2}`} />
    })}
    <circle className={`vc-graph-lane-${row.lane % LANE_COLORS}`} cx={x(row.lane)} cy={middle} r={3.5} />
  </svg>
}

/**
 * The commit graph of the current branch and its upstream, newest first.
 * Pages of up to 50 commits come from the backend on demand; a commit opens
 * to its files, each file to its changed items, with "restore this version".
 */
export function GitHistory({ rootPath, vc, reloadKey, state, onReview }: GitHistoryProps) {
  const { t, language } = useLanguage()
  const [open, setOpen] = useState(true)
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
        setFailure({ key, message: versionControlErrorMessage(result.error, t) })
      }
    })
    return () => {
      active = false
      void cancelVersionControlOperation(operationId)
    }
  }, [current, key, open, rootPath, t])

  useEffect(() => () => {
    if (moreOperationRef.current) void cancelVersionControlOperation(moreOperationRef.current)
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
    else if (result.error.kind !== 'cancelled') setFailure({ key: from.key, message: versionControlErrorMessage(result.error, t) })
  }

  const error = failure?.key === key ? failure.message : null
  const loading = open && !current && !error
  const commits = current?.commits
  const graph = useMemo(() => layoutGraph(commits ?? []), [commits])
  const graphWidth = Math.min(graph.width, MAX_LANES)

  return <section className="vc-change-section vc-history">
    <header className="vc-section-header">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}<h3>{t('vc.history.title')}</h3>
      </button>
      <GitRemoteActions rootPath={rootPath} vc={vc} state={state} />
    </header>
    {open && <div className="vc-history-body">
      {error && <InlineAlert>{error}</InlineAlert>}
      {loading && <p className="vc-section-empty" role="status">{t('vc.history.loading')}</p>}
      {current && current.commits.length === 0 && <p className="vc-section-empty">{t('vc.history.empty')}</p>}
      {current && current.commits.length > 0 && <ol className="vc-history-list" aria-label={t('vc.history.title')}>
        {current.commits.map((commit, index) => {
          const at = commit.time * 1000
          const isOpen = expanded === commit.id
          const refs = [...commit.refs].sort((a, b) => Number(b === state.branch) - Number(a === state.branch))
          const details = `${commit.authorName} <${commit.authorEmail}> · ${formatDateTime(at, language)} · ${commit.id.slice(0, 7)}`
          return <li key={commit.id} className="vc-history-commit" data-open={isOpen}>
            <button type="button" className="vc-history-toggle" aria-expanded={isOpen} title={details} onClick={() => setExpanded(isOpen ? null : commit.id)}>
              <GraphCell row={graph.rows[index]} width={graphWidth} />
              <span className="vc-history-summary">{commit.summary || t('vc.history.noMessage')}</span>
              <small className="vc-history-author">{commit.authorName}</small>
              <small className="vc-history-time">{formatRelativeTime(at, language)}</small>
              {refs.map((ref) => <span key={ref} className="vc-history-ref" data-kind={ref === state.branch ? 'current' : ref.startsWith('origin/') ? 'remote' : 'local'}>{ref}</span>)}
            </button>
            {isOpen && <ul className="vc-history-files">
              {commit.files.length === 0 && <li className="vc-muted">{t('vc.history.noFiles')}</li>}
              {commit.files.map((file) => <CommitFile key={file} rootPath={rootPath} vc={vc} commit={commit.id} file={file} onReview={onReview} />)}
            </ul>}
          </li>
        })}
      </ol>}
      {current && current.nextOffset !== null && <Button variant="ghost" isLoading={loadingMore} onClick={() => void loadMore(current)}>{t('vc.history.loadMore')}</Button>}
    </div>}
  </section>
}

function CommitFile({ rootPath, vc, commit, file, onReview }: { rootPath: string; vc: VersionControl; commit: string; file: string; onReview?: GitHistoryProps['onReview'] }) {
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
      setChanges(result.ok ? { value: result.value, error: null } : { value: null, error: versionControlErrorMessage(result.error, t) })
    })
    return () => {
      active = false
    }
  }, [changes, commit, file, open, rootPath, t])

  const restore = async () => {
    setConfirmRestore(false)
    await vc.runGit(
      () => restoreGitFile(rootPath, commit, file),
      (value) => value.files,
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
      : <ul className="vc-history-items">{changes.value.items.map((item) => {
        const copy = <>
          <span>{item.label}</span>
          <small>{t(itemKindLabelKey(item.itemKind))} · {t(`vc.change.${item.changeKind}`)}</small>
        </>
        const detail = changes.value
        return <li key={item.id}>
          {onReview && detail
            ? <button type="button" className="vc-history-item" onClick={() => onReview({ fileName: file, fileLabel: label, changes: detail, item, historical: true })}>{copy}</button>
            : copy}
        </li>
      })}</ul>)}
    {confirmRestore && <ConfirmDialog
      title={t('vc.history.restore')}
      description={t('vc.history.restoreConfirm', { file: label })}
      confirmLabel={t('vc.history.restore')}
      cancelLabel={t('vc.cancel')}
      closeAriaLabel={t('vc.cancel')}
      onCancel={() => setConfirmRestore(false)}
      onConfirm={() => void restore()}
    />}
  </li>
}
