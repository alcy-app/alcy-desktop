import { useEffect, useState } from 'react'
import {
  abortGitMerge,
  createGitBranch,
  deleteGitBranch,
  fetchGitRemote,
  finishGitMerge,
  getGitIdentity,
  mergeGitBranch,
  pushGitRemote,
  setGitRemote,
  switchGitBranch,
  type GitStateDto,
} from '../../bindings/local-git'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { MenuItem, MenuSeparator, OptionsMenu } from '../../shared/ui/Menu'
import { Modal } from '../../shared/ui/Modal'
import { BranchIcon, ChevronDownIcon, DownloadIcon, GitPullIcon, GitPushIcon, Spinner } from '../../shared/ui/icons'
import { suggestBranchName, toBranchName } from './branch-name'
import { pullFromRemote } from './git-remote'
import type { VersionControl } from './use-version-control'

interface GitProps {
  rootPath: string
  vc: VersionControl
  state: GitStateDto
}

/** The current branch, in the panel's header; opens the branches to switch to. */
export function GitBranchSelect({ rootPath, vc, state }: GitProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const branches = state.branches.includes(state.branch) ? state.branches : [state.branch, ...state.branches]
  const name = <span className="vc-git-branch-name">{state.branch}</span>
  if (branches.length < 2 || state.merge !== null) {
    return <div className="vc-git-branch-label"><BranchIcon size={13} />{name}</div>
  }
  const switchTo = (branch: string) => {
    setOpen(false)
    if (branch !== state.branch) void vc.runGit(() => switchGitBranch(rootPath, branch), (value) => value.files)
  }
  return <OptionsMenu
    label={`${t('vc.git.branch')}: ${state.branch}`}
    isOpen={open}
    onToggle={() => setOpen((current) => !current)}
    onClose={() => setOpen(false)}
    icon={<><BranchIcon size={13} />{name}<ChevronDownIcon size={12} className="vc-git-branch-chevron" /></>}
    wrapperClassName="vc-git-branch-host"
    buttonClassName="vc-git-branch-trigger"
    menuClassName="vc-git-branch-menu"
    menuPortal
    menuAlign="start"
  >
    {branches.map((branch) => <MenuItem key={branch} label={branch} selected={branch === state.branch} disabled={vc.busy !== null} onSelect={() => switchTo(branch)} />)}
  </OptionsMenu>
}

function useRemoteActions(rootPath: string, vc: VersionControl) {
  return {
    fetch: () => vc.runGit((operationId) => fetchGitRemote(rootPath, operationId)),
    pull: () => pullFromRemote(vc, rootPath),
    push: () => vc.runGit((operationId) => pushGitRemote(rootPath, operationId)),
  }
}

type GitDialog = 'create' | 'merge' | 'delete' | 'remote' | 'removeRemote'

/** The panel's "…" menu for git: remote operations, branches and the remote's URL. */
export function GitActionsMenu({ rootPath, vc, state, label, onUnlink }: GitProps & { label: string; onUnlink: () => void }) {
  const { t } = useLanguage()
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<GitDialog | null>(null)
  const actions = useRemoteActions(rootPath, vc)
  const locked = vc.busy !== null || state.merge !== null
  const noRemote = state.remote === null
  const others = state.branches.filter((branch) => branch !== state.branch)
  const choose = (run: () => void) => () => {
    setMenuOpen(false)
    run()
  }
  const closeDialog = () => setDialog(null)

  return <>
    <OptionsMenu label={label} isOpen={menuOpen} onToggle={() => setMenuOpen((open) => !open)} onClose={() => setMenuOpen(false)} menuPortal>
      <MenuItem label={t('vc.git.pull')} disabled={locked || noRemote} onSelect={choose(() => void actions.pull())} />
      <MenuItem label={t('vc.git.push')} disabled={locked || noRemote || !state.hasCommits} onSelect={choose(() => void actions.push())} />
      <MenuItem label={t('vc.git.fetch')} disabled={locked || noRemote} onSelect={choose(() => void actions.fetch())} />
      <MenuSeparator />
      <MenuItem label={t('vc.git.newBranch')} disabled={locked || !state.hasCommits} onSelect={choose(() => setDialog('create'))} />
      <MenuItem label={t('vc.git.mergeBranch')} disabled={locked || others.length === 0} onSelect={choose(() => setDialog('merge'))} />
      <MenuItem label={t('vc.git.deleteBranch')} disabled={locked || others.length === 0} onSelect={choose(() => setDialog('delete'))} />
      <MenuSeparator />
      <MenuItem label={t(noRemote ? 'vc.git.addRemote' : 'vc.git.editRemote')} disabled={vc.busy !== null} onSelect={choose(() => setDialog('remote'))} />
      {!noRemote && <MenuItem label={t('vc.git.removeRemote')} disabled={vc.busy !== null} onSelect={choose(() => setDialog('removeRemote'))} />}
      <MenuSeparator />
      <MenuItem label={t('vc.action.unlink')} onSelect={choose(onUnlink)} />
    </OptionsMenu>
    {dialog === 'create' && <CreateBranchDialog rootPath={rootPath} vc={vc} state={state} onClose={closeDialog} />}
    {dialog === 'merge' && <MergeBranchDialog rootPath={rootPath} vc={vc} state={state} others={others} onClose={closeDialog} />}
    {dialog === 'delete' && <DeleteBranchDialog rootPath={rootPath} vc={vc} others={others} onClose={closeDialog} />}
    {dialog === 'remote' && <RemoteDialog rootPath={rootPath} vc={vc} state={state} onClose={closeDialog} />}
    {dialog === 'removeRemote' && <ConfirmDialog
      title={t('vc.git.removeRemote')}
      description={t('vc.git.removeRemoteConfirm')}
      confirmLabel={t('vc.git.removeRemote')}
      cancelLabel={t('vc.cancel')}
      closeAriaLabel={t('vc.cancel')}
      onCancel={closeDialog}
      onConfirm={() => {
        closeDialog()
        void vc.runGit(() => setGitRemote(rootPath, null))
      }}
      tone="primary"
    />}
  </>
}

/** Fetch, pull and push in the graph's header, with how far the branch is from `origin`. */
export function GitRemoteActions({ rootPath, vc, state }: GitProps) {
  const { t } = useLanguage()
  const [running, setRunning] = useState<'fetch' | 'pull' | 'push' | null>(null)
  const actions = useRemoteActions(rootPath, vc)
  if (state.remote === null) return null
  const locked = vc.busy !== null || state.merge !== null
  const ahead = state.tracking?.ahead ?? 0
  const behind = state.tracking?.behind ?? 0
  const run = async (action: 'fetch' | 'pull' | 'push') => {
    setRunning(action)
    await actions[action]()
    setRunning(null)
  }
  return <div className="vc-graph-actions">
    {(ahead > 0 || behind > 0) && <span className="vc-graph-tracking" aria-hidden="true">{behind > 0 && `↓${behind}`} {ahead > 0 && `↑${ahead}`}</span>}
    <IconButton icon={running === 'fetch' ? <Spinner size={13} /> : <DownloadIcon size={13} />} label={t('vc.git.fetch')} disabled={locked} onClick={() => void run('fetch')} />
    <IconButton icon={running === 'pull' ? <Spinner size={13} /> : <GitPullIcon size={13} />} label={behind > 0 ? t('vc.git.pullCount', { count: behind }) : t('vc.git.pull')} disabled={locked} onClick={() => void run('pull')} />
    <IconButton icon={running === 'push' ? <Spinner size={13} /> : <GitPushIcon size={13} />} label={ahead > 0 ? t('vc.git.pushCount', { count: ahead }) : t('vc.git.push')} disabled={locked || !state.hasCommits} onClick={() => void run('push')} />
  </div>
}

function CreateBranchDialog({ rootPath, vc, state, onClose }: GitProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const taken = state.branches
  const fallbackWord = t('vc.git.branchFallback')
  // A ready-to-use name; the git user's name arrives a moment later and
  // replaces the fallback unless the person already typed something.
  const [fallback] = useState(() => suggestBranchName(null, taken, new Date(), fallbackWord))
  const [name, setName] = useState(fallback)
  const [switchTo, setSwitchTo] = useState(true)

  useEffect(() => {
    let active = true
    void getGitIdentity().then((result) => {
      const person = result.ok ? result.value.effective?.name : null
      if (active && person) setName((current) => current === fallback ? suggestBranchName(person, taken, new Date(), fallbackWord) : current)
    })
    return () => {
      active = false
    }
  }, [fallback, fallbackWord, taken])

  const branch = toBranchName(name)
  const create = async () => {
    if (!branch) return
    const result = await vc.runGit(() => createGitBranch(rootPath, branch, switchTo), (value) => value.files)
    if (result.ok) onClose()
  }

  return <Modal title={t('vc.git.newBranch')} closeAriaLabel={t('vc.cancel')} onClose={onClose}>
    <form className="vc-git-dialog" onSubmit={(event) => { event.preventDefault(); void create() }}>
      <Input mono aria-label={t('vc.git.newBranchName')} placeholder={t('vc.git.newBranchName')} value={name} spellCheck={false} autoComplete="off" autoFocus onChange={(event) => setName(event.target.value)} />
      {branch !== '' && branch !== name.trim() && <p className="vc-muted" role="status">{t('vc.git.branchWillBe', { name: branch })}</p>}
      <label className="vc-checkbox-row">
        <Checkbox checked={switchTo} onChange={(event) => setSwitchTo(event.target.checked)} />
        <span>{t('vc.git.switchToNew')}</span>
      </label>
      <div className="vc-actions">
        <Button variant="ghost" onClick={onClose}>{t('vc.cancel')}</Button>
        <Button type="submit" disabled={branch === '' || vc.busy !== null} isLoading={vc.busy === 'git'}>{t('vc.git.create')}</Button>
      </div>
    </form>
  </Modal>
}

/** Chooses a branch inside a dialog, with the same menu as the panel's header. */
function BranchPicker({ label, branches, value, open, onOpenChange, onChange }: {
  label: string
  branches: string[]
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (branch: string) => void
}) {
  return <OptionsMenu
    label={`${label}: ${value}`}
    isOpen={open}
    onToggle={() => onOpenChange(!open)}
    onClose={() => onOpenChange(false)}
    icon={<><BranchIcon size={13} /><span className="vc-git-branch-name">{value}</span><ChevronDownIcon size={12} className="vc-git-branch-chevron" /></>}
    wrapperClassName="vc-git-branch-picker-host"
    buttonClassName="vc-git-branch-picker"
    menuClassName="vc-git-branch-menu vc-git-branch-picker-menu"
    menuPortal
    menuAlign="start"
  >
    {branches.map((branch) => <MenuItem key={branch} label={branch} selected={branch === value} onSelect={() => {
      onOpenChange(false)
      onChange(branch)
    }} />)}
  </OptionsMenu>
}

function MergeBranchDialog({ rootPath, vc, state, others, onClose }: GitProps & { others: string[]; onClose: () => void }) {
  const { t } = useLanguage()
  const [chosen, setChosen] = useState(others[0] ?? '')
  const [picking, setPicking] = useState(false)
  const merge = async () => {
    const result = await vc.runGit(() => mergeGitBranch(rootPath, chosen), (value) => value.files)
    if (result.ok) onClose()
  }
  return <Modal title={t('vc.git.mergeBranch')} closeAriaLabel={t('vc.cancel')} onClose={onClose} onEscape={picking ? () => setPicking(false) : undefined}>
    <div className="vc-git-dialog">
      <BranchPicker label={t('vc.git.mergeBranch')} branches={others} value={chosen} open={picking} onOpenChange={setPicking} onChange={setChosen} />
      <div className="vc-actions">
        <Button variant="ghost" onClick={onClose}>{t('vc.cancel')}</Button>
        <Button className="vc-git-merge-submit" title={state.branch} disabled={!chosen || vc.busy !== null} isLoading={vc.busy === 'git'} onClick={() => void merge()}>{t('vc.git.mergeInto', { name: state.branch })}</Button>
      </div>
    </div>
  </Modal>
}

function DeleteBranchDialog({ rootPath, vc, others, onClose }: { rootPath: string; vc: VersionControl; others: string[]; onClose: () => void }) {
  const { t } = useLanguage()
  const [chosen, setChosen] = useState(others[0] ?? '')
  const [picking, setPicking] = useState(false)
  const remove = async () => {
    const result = await vc.runGit(() => deleteGitBranch(rootPath, chosen))
    if (result.ok) onClose()
  }
  return <Modal title={t('vc.git.deleteBranch')} closeAriaLabel={t('vc.cancel')} onClose={onClose} onEscape={picking ? () => setPicking(false) : undefined}>
    <div className="vc-git-dialog">
      <BranchPicker label={t('vc.git.deleteBranch')} branches={others} value={chosen} open={picking} onOpenChange={setPicking} onChange={setChosen} />
      <p className="vc-muted">{t('vc.git.deleteConfirm', { name: chosen })}</p>
      <div className="vc-actions">
        <Button variant="ghost" onClick={onClose}>{t('vc.cancel')}</Button>
        <Button variant="danger" disabled={!chosen || vc.busy !== null} onClick={() => void remove()}>{t('vc.git.delete')}</Button>
      </div>
    </div>
  </Modal>
}

function RemoteDialog({ rootPath, vc, state, onClose }: GitProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [url, setUrl] = useState(state.remote ?? '')
  const save = async () => {
    const result = await vc.runGit(() => setGitRemote(rootPath, url.trim()))
    if (result.ok) onClose()
  }
  return <Modal title={t(state.remote === null ? 'vc.git.addRemote' : 'vc.git.editRemote')} closeAriaLabel={t('vc.cancel')} onClose={onClose} className="ui-modal--md">
    <form className="vc-git-dialog" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <Input mono autoFocus aria-label={t('vc.git.remoteUrl')} placeholder={t('vc.git.remotePlaceholder')} value={url} spellCheck={false} autoComplete="off" onChange={(event) => setUrl(event.target.value)} />
      <p className="vc-muted">{t('vc.git.remoteHint')}</p>
      <div className="vc-actions">
        <Button variant="ghost" onClick={onClose}>{t('vc.cancel')}</Button>
        <Button type="submit" disabled={url.trim() === '' || vc.busy !== null} isLoading={vc.busy === 'git'}>{t('vc.git.saveRemote')}</Button>
      </div>
    </form>
  </Modal>
}

/** A merge waiting for decisions: finish once conflicts are resolved, or cancel. */
export function GitMergeBanner({ rootPath, vc, label }: { rootPath: string; vc: VersionControl; label: string }) {
  const { t } = useLanguage()
  const [message, setMessage] = useState('')
  const [confirmAbort, setConfirmAbort] = useState(false)
  const unresolved = vc.files.filter((file) => file.state === 'conflict').length
  const working = vc.busy !== null

  const finish = () => vc.runGit(() => finishGitMerge(rootPath, message))
  const abort = async () => {
    setConfirmAbort(false)
    await vc.runGit(() => abortGitMerge(rootPath), (value) => value.files)
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
      cancelLabel={t('vc.cancel')}
      closeAriaLabel={t('vc.cancel')}
      onCancel={() => setConfirmAbort(false)}
      onConfirm={() => void abort()}
    />}
  </section>
}
