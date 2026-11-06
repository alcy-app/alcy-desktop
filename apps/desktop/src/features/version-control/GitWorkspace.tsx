import { useEffect, useState } from 'react'
import { cancelGitlabOperation } from '../../bindings/cancel-gitlab-operation'
import {
  abortGitMerge,
  createGitBranch,
  deleteGitBranch,
  finishGitMerge,
  getGitIdentity,
  getGitPeers,
  mergeGitBranch,
  setGitSharedFolder,
  switchGitBranch,
  type GitPeerDto,
  type GitStateDto,
} from '../../bindings/local-git'
import { pickWorkspaceFolder } from '../../bindings/pick-workspace-folder'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { BranchIcon, FolderIcon, GitPullIcon, PlusIcon, RefreshIcon, Spinner, TrashIcon } from '../../shared/ui/icons'
import { formatRelativeTime } from '../documents/document-format'
import { suggestBranchName, toBranchName } from './branch-name'
import { syncSharedFolder } from './git-sync'
import type { VersionControl } from './use-version-control'

type BranchMode = 'create' | 'merge' | 'delete' | null

/** Current branch, switching, creating, merging and deleting branches. */
export function GitBranches({ rootPath, vc, state }: { rootPath: string; vc: VersionControl; state: GitStateDto }) {
  const { t } = useLanguage()
  const [mode, setMode] = useState<BranchMode>(null)
  const [name, setName] = useState('')
  const [switchTo, setSwitchTo] = useState(true)
  const others = state.branches.filter((branch) => branch !== state.branch)
  const [target, setTarget] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const working = vc.busy !== null
  const locked = working || state.merge !== null
  const branches = state.branches.includes(state.branch) ? state.branches : [state.branch, ...state.branches]
  const chosen = others.includes(target) ? target : others[0] ?? ''

  const open = (next: BranchMode) => {
    const opening = mode !== next
    setMode(opening ? next : null)
    if (next !== 'create' || !opening) return
    // A ready-to-use name; the git user's name arrives a moment later and
    // replaces the fallback unless the person already typed something.
    const suggest = (person: string | null | undefined) => suggestBranchName(person, state.branches, new Date(), t('vc.git.branchFallback'))
    const fallback = suggest(null)
    setName(fallback)
    void getGitIdentity().then((result) => {
      const person = result.ok ? result.value.effective?.name : null
      if (person) setName((current) => current === fallback ? suggest(person) : current)
    })
  }
  const branchName = toBranchName(name)
  const create = async () => {
    const branch = branchName
    if (!branch) return
    const result = await vc.runGit(
      () => createGitBranch(rootPath, branch, switchTo),
      (value) => ({ files: value.files, notice: t('vc.git.branchCreated', { name: branch }) }),
    )
    if (result.ok) setMode(null)
  }
  const merge = async () => {
    if (!chosen) return
    const result = await vc.runGit(
      () => mergeGitBranch(rootPath, chosen),
      (value) => ({
        files: value.files,
        notice: value.outcome === 'conflicts'
          ? t('vc.git.syncMerge', { name: chosen })
          : value.outcome === 'upToDate' ? t('vc.git.mergeUpToDate', { name: chosen }) : t('vc.git.merged', { name: chosen }),
      }),
    )
    if (result.ok) setMode(null)
  }
  const remove = async () => {
    setConfirmDelete(false)
    const branch = chosen
    const result = await vc.runGit(() => deleteGitBranch(rootPath, branch), () => ({ notice: t('vc.git.branchDeleted', { name: branch }) }))
    if (result.ok) setMode(null)
  }

  return <section className="vc-git-branches" aria-label={t('vc.git.branch')}>
    <div className="vc-git-branch-row">
      <BranchIcon size={13} />
      <Select
        aria-label={t('vc.git.branch')}
        value={state.branch}
        disabled={locked || branches.length < 2}
        onChange={(event) => {
          const branch = event.target.value
          void vc.runGit(() => switchGitBranch(rootPath, branch), (value) => ({ files: value.files, notice: t('vc.git.switched', { name: branch }) }))
        }}
      >
        {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
      </Select>
      <IconButton icon={<PlusIcon size={13} />} label={t('vc.git.newBranch')} disabled={locked || !state.hasCommits} onClick={() => open('create')} />
      <IconButton icon={<GitPullIcon size={13} />} label={t('vc.git.mergeBranch')} disabled={locked || others.length === 0} onClick={() => open('merge')} />
      <IconButton icon={<TrashIcon size={13} />} label={t('vc.git.deleteBranch')} disabled={locked || others.length === 0} onClick={() => open('delete')} />
    </div>
    {!state.hasCommits && <p className="vc-muted">{t('vc.git.firstCommitHint')}</p>}

    {mode === 'create' && <form className="vc-git-branch-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <Input mono aria-label={t('vc.git.newBranchName')} placeholder={t('vc.git.newBranchName')} value={name} spellCheck={false} autoComplete="off" autoFocus onChange={(event) => setName(event.target.value)} />
      {branchName !== '' && branchName !== name.trim() && <p className="vc-muted" role="status">{t('vc.git.branchWillBe', { name: branchName })}</p>}
      <label className="vc-checkbox-row">
        <Checkbox checked={switchTo} onChange={(event) => setSwitchTo(event.target.checked)} />
        <span>{t('vc.git.switchToNew')}</span>
      </label>
      <div className="vc-actions">
        <Button variant="ghost" onClick={() => setMode(null)}>{t('gitlab.cancel')}</Button>
        <Button type="submit" disabled={branchName === '' || working} isLoading={vc.busy === 'git'}>{t('vc.git.create')}</Button>
      </div>
    </form>}

    {(mode === 'merge' || mode === 'delete') && <div className="vc-git-branch-form">
      <Select aria-label={mode === 'merge' ? t('vc.git.mergeBranch') : t('vc.git.deleteBranch')} value={chosen} onChange={(event) => setTarget(event.target.value)}>
        {others.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
      </Select>
      <div className="vc-actions">
        <Button variant="ghost" onClick={() => setMode(null)}>{t('gitlab.cancel')}</Button>
        {mode === 'merge'
          ? <Button disabled={!chosen || working} isLoading={vc.busy === 'git'} onClick={() => void merge()}>{t('vc.git.mergeInto', { name: state.branch })}</Button>
          : <Button variant="danger" disabled={!chosen || working} onClick={() => setConfirmDelete(true)}>{t('vc.git.delete')}</Button>}
      </div>
    </div>}

    {confirmDelete && <ConfirmDialog
      title={t('vc.git.deleteBranch')}
      description={t('vc.git.deleteConfirm', { name: chosen })}
      confirmLabel={t('vc.git.delete')}
      cancelLabel={t('gitlab.cancel')}
      closeAriaLabel={t('gitlab.cancel')}
      onCancel={() => setConfirmDelete(false)}
      onConfirm={() => void remove()}
    />}
  </section>
}

/** A merge waiting for decisions: finish once conflicts are resolved, or cancel. */
export function GitMergeBanner({ rootPath, vc, label }: { rootPath: string; vc: VersionControl; label: string }) {
  const { t } = useLanguage()
  const [message, setMessage] = useState('')
  const [confirmAbort, setConfirmAbort] = useState(false)
  const unresolved = vc.files.filter((file) => file.state === 'conflict').length
  const working = vc.busy !== null

  const finish = () => vc.runGit(
    () => finishGitMerge(rootPath, message),
    () => ({ notice: t('vc.git.mergeFinished', { name: label }) }),
  )
  const abort = async () => {
    setConfirmAbort(false)
    await vc.runGit(() => abortGitMerge(rootPath), (value) => ({ files: value.files, notice: t('vc.git.mergeAborted') }))
  }

  return <section className="vc-git-merge" aria-label={t('vc.git.mergingWith', { name: label })}>
    <strong>{t('vc.git.mergingWith', { name: label })}</strong>
    <p className="vc-muted" role="status">{unresolved > 0 ? t('vc.git.mergeConflicts', { count: unresolved }) : t('vc.git.mergeReady')}</p>
    <Input aria-label={t('vc.commit.messageLabel')} placeholder={t('vc.git.mergeMessagePlaceholder', { name: label })} value={message} disabled={working} onChange={(event) => setMessage(event.target.value)} />
    <div className="vc-actions">
      <Button variant="ghost" disabled={working} onClick={() => setConfirmAbort(true)}>{t('vc.git.abortMerge')}</Button>
      <Button disabled={unresolved > 0 || working} isLoading={vc.busy === 'git'} onClick={() => void finish()}>{t('vc.git.finishMerge')}</Button>
    </div>
    {confirmAbort && <ConfirmDialog
      title={t('vc.git.abortMerge')}
      description={t('vc.git.abortConfirm')}
      confirmLabel={t('vc.git.abortMerge')}
      cancelLabel={t('gitlab.cancel')}
      closeAriaLabel={t('gitlab.cancel')}
      onCancel={() => setConfirmAbort(false)}
      onConfirm={() => void abort()}
    />}
  </section>
}

const PEER_STATE_KEYS = {
  upToDate: 'vc.git.peerUpToDate',
  incoming: 'vc.git.peerIncoming',
  syncing: 'vc.git.peerSyncing',
} as const

/** The shared folder: choose it, see everyone's state and sync. */
export function GitSharedFolder({ rootPath, vc, state }: { rootPath: string; vc: VersionControl; state: GitStateDto }) {
  const { t, language } = useLanguage()
  const [peers, setPeers] = useState<{ key: string; list: GitPeerDto[]; error: string | null } | null>(null)
  const [reload, setReload] = useState(0)
  const [confirmStop, setConfirmStop] = useState(false)
  const folder = state.sharedFolder
  const key = `${rootPath}:${folder ?? ''}:${state.branch}:${vc.gitVersion}:${reload}`
  const working = vc.busy !== null

  useEffect(() => {
    if (!folder) return
    const operationId = crypto.randomUUID()
    let active = true
    void getGitPeers(rootPath, operationId).then((result) => {
      if (!active) return
      if (result.ok) setPeers({ key, list: result.value, error: null })
      else if (result.error.kind !== 'cancelled') setPeers({ key, list: [], error: gitlabErrorMessage(result.error, t) })
    })
    return () => {
      active = false
      void cancelGitlabOperation(operationId)
    }
  }, [folder, key, rootPath, t])

  const choose = async () => {
    const path = await pickWorkspaceFolder()
    if (path === null) return
    await vc.runGit(() => setGitSharedFolder(rootPath, path), (link) => ({ link, notice: t('vc.git.sharedSet') }))
  }
  const stop = async () => {
    setConfirmStop(false)
    await vc.runGit(() => setGitSharedFolder(rootPath, null), (link) => ({ link, notice: t('vc.git.sharedStopped') }))
  }
  const sync = () => syncSharedFolder(vc, rootPath, t)

  const current = peers?.key === key ? peers : null
  const incoming = current?.list.filter((peer) => peer.state === 'incoming').length ?? 0

  return <section className="vc-change-section vc-git-shared">
    <header className="vc-section-header"><h3>{t('vc.git.sharedTitle')}</h3>
      {folder && <IconButton icon={current || !folder ? <RefreshIcon size={13} /> : <Spinner size={13} />} label={t('vc.git.refreshPeers')} disabled={working} onClick={() => setReload((value) => value + 1)} />}
    </header>
    {!folder ? <>
      <p className="vc-muted">{t('vc.git.sharedDescription')}</p>
      <Button variant="ghost" disabled={working || state.merge !== null} onClick={() => void choose()}><FolderIcon size={13} />{t('vc.git.chooseFolder')}</Button>
    </> : <>
      <p className="vc-git-shared-path" title={folder}><FolderIcon size={13} /><span>{folder}</span></p>
      <Button className="vc-primary-action" disabled={working || state.merge !== null} isLoading={vc.busy === 'git'} onClick={() => void sync()}>
        {incoming > 0 ? t('vc.git.syncWithCount', { count: incoming }) : t('vc.git.sync')}
      </Button>
      {current?.error && <InlineAlert>{current.error}</InlineAlert>}
      {current && current.list.length === 0 && !current.error && <p className="vc-section-empty">{t('vc.git.noPeers')}</p>}
      {current && current.list.length > 0 && <ul className="vc-git-peers" aria-label={t('vc.git.peers')}>
        {current.list.map((peer) => <li key={peer.peer} className="vc-git-peer" data-state={peer.state}>
          <span className="vc-git-peer-name">{peer.name}</span>
          <small>{t(PEER_STATE_KEYS[peer.state])}{peer.time > 0 && <> · {formatRelativeTime(peer.time * 1000, language)}</>}</small>
        </li>)}
      </ul>}
      <button type="button" className="vc-section-action" disabled={working} onClick={() => setConfirmStop(true)}>{t('vc.git.stopSharing')}</button>
    </>}
    {confirmStop && <ConfirmDialog
      title={t('vc.git.stopSharing')}
      description={t('vc.git.stopSharingConfirm')}
      confirmLabel={t('vc.git.stopSharing')}
      cancelLabel={t('gitlab.cancel')}
      closeAriaLabel={t('gitlab.cancel')}
      onCancel={() => setConfirmStop(false)}
      onConfirm={() => void stop()}
      tone="primary"
    />}
  </section>
}
