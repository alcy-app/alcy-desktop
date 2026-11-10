import { useRef, useState } from 'react'
import { cancelVersionControlOperation } from '../../bindings/cancel-version-control-operation'
import type { WorkspaceDto } from '../../bindings/create-workspace'
import { cloneGitWorkspace, inspectWorkspaceFolder, trustGitFolder } from '../../bindings/local-git'
import { openWorkspace } from '../../bindings/open-workspace'
import { pickWorkspaceFolder } from '../../bindings/pick-workspace-folder'
import { versionControlErrorMessage } from '../version-control-error-message'
import { useLanguage } from '../i18n/use-language'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/icons'
import { InlineAlert } from '../ui/InlineAlert'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { Tabs } from '../ui/Tabs'
import { workspaceErrorMessageKey } from '../workspace-command-error'
import './import-workspace-dialog.css'

type Source = 'folder' | 'git'
type Action = 'open' | 'clone' | 'trust'

interface ImportWorkspaceDialogProps {
  onClose: () => void
  onWorkspaceReady: (workspace: WorkspaceDto) => void
}

interface ChoiceCardProps {
  id: string
  title: string
  description: string
  disabled: boolean
  loading: boolean
  autoFocus?: boolean
  onClick: () => void
}

/** One way of importing the folder; the whole card is the button. */
function ChoiceCard({ id, title, description, disabled, loading, autoFocus, onClick }: ChoiceCardProps) {
  return (
    <button type="button" className="import-workspace-choice" autoFocus={autoFocus} disabled={disabled} aria-busy={loading || undefined} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onClick={onClick}>
      <span className="import-workspace-choice-title" id={`${id}-title`}>
        {title}
        {loading && <Spinner size={14} />}
      </span>
      <span className="import-workspace-hint" id={`${id}-description`}>{description}</span>
    </button>
  )
}

/** Brings in an existing workspace, from a folder on this computer or a git repository. */
export function ImportWorkspaceDialog({ onClose, onWorkspaceReady }: ImportWorkspaceDialogProps) {
  const { t } = useLanguage()
  const [source, setSource] = useState<Source>('folder')
  const [url, setUrl] = useState('')
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** A folder with a repository, waiting for the person to choose how to import it. */
  const [repositoryFolder, setRepositoryFolder] = useState<string | null>(null)
  /** What git wants trusted before it clones a folder owned by someone else. */
  const [untrustedPath, setUntrustedPath] = useState<string | null>(null)
  const cloneRef = useRef<string | null>(null)
  const busy = action !== null

  const openRoot = async (rootPath: string) => {
    setAction('open')
    setError(null)
    setUntrustedPath(null)
    const result = await openWorkspace({ rootPath })
    setAction(null)
    if (result.ok) onWorkspaceReady(result.value)
    else setError(t(workspaceErrorMessageKey(result.error), { message: result.error.message }))
  }
  const chooseFolder = async () => {
    const rootPath = await pickWorkspaceFolder()
    if (rootPath === null) return
    setAction('open')
    setError(null)
    const inspection = await inspectWorkspaceFolder(rootPath)
    if (inspection.ok && inspection.value.canCloneAsRemote) {
      setAction(null)
      setRepositoryFolder(rootPath)
    } else {
      await openRoot(rootPath)
    }
  }
  const clone = async () => {
    const operationId = crypto.randomUUID()
    cloneRef.current = operationId
    setAction('clone')
    setError(null)
    setUntrustedPath(null)
    const target = repositoryFolder !== null ? { url: repositoryFolder, fromFolder: true } : { url: url.trim() }
    const result = await cloneGitWorkspace({ operationId, ...target })
    cloneRef.current = null
    setAction(null)
    if (result.ok) onWorkspaceReady(result.value)
    else if (result.error.kind === 'gitUntrustedFolder') setUntrustedPath(result.error.path)
    else if (result.error.kind !== 'cancelled') setError(versionControlErrorMessage(result.error, t))
  }
  const trustAndClone = async () => {
    if (untrustedPath === null) return
    setAction('trust')
    setError(null)
    const result = await trustGitFolder(untrustedPath)
    if (result.ok) {
      await clone()
    } else {
      setAction(null)
      setError(versionControlErrorMessage(result.error, t))
    }
  }
  const close = () => {
    if (cloneRef.current) void cancelVersionControlOperation(cloneRef.current)
    onClose()
  }
  const backToFolderPicker = () => {
    setRepositoryFolder(null)
    setUntrustedPath(null)
    setError(null)
  }
  const choose = (next: Source) => {
    if (busy) return
    setSource(next)
    setRepositoryFolder(null)
    setUntrustedPath(null)
    setError(null)
  }

  return (
    <Modal title={t('workspaceImport.title')} closeAriaLabel={t('workspaceImport.close')} onClose={close} className="ui-modal--md">
      <div className="import-workspace-body">
        <Tabs<Source>
          ariaLabel={t('workspaceImport.source')}
          idPrefix="import-workspace-"
          activeTab={source}
          onChange={choose}
          tabs={[
            { id: 'folder', label: t('workspaceImport.folder') },
            { id: 'git', label: t('workspaceImport.git') },
          ]}
        />
        {source === 'folder' ? (
          <div className="import-workspace-panel" role="tabpanel" id="tabpanel-import-workspace-folder" aria-labelledby="tab-import-workspace-folder">
            {repositoryFolder === null ? (
              <>
                <p className="import-workspace-hint">{t('workspaceImport.folderHint')}</p>
                <Button disabled={busy} isLoading={busy} onClick={() => void chooseFolder()}>{t('workspaceImport.chooseFolder')}</Button>
              </>
            ) : (
              <>
                <p className="import-workspace-hint">{t('workspaceImport.repositoryFound')}</p>
                <p className="import-workspace-hint import-workspace-path">{repositoryFolder}</p>
                <div className="import-workspace-choices">
                  <ChoiceCard id="import-workspace-clone-choice" autoFocus title={t('workspaceImport.cloneAsRemote')} description={t('workspaceImport.cloneAsRemoteHint')} disabled={busy} loading={action === 'clone'} onClick={() => void clone()} />
                  <ChoiceCard id="import-workspace-open-choice" title={t('workspaceImport.useFolder')} description={t('workspaceImport.useFolderHint')} disabled={busy} loading={action === 'open'} onClick={() => void openRoot(repositoryFolder)} />
                </div>
                <Button variant="ghost" disabled={busy} onClick={backToFolderPicker}>{t('workspaceImport.back')}</Button>
              </>
            )}
          </div>
        ) : (
          <form className="import-workspace-panel" role="tabpanel" id="tabpanel-import-workspace-git" aria-labelledby="tab-import-workspace-git" onSubmit={(event) => { event.preventDefault(); void clone() }}>
            <div className="import-workspace-clone">
              <Input mono autoFocus aria-label={t('workspaceImport.gitUrl')} placeholder={t('workspaceImport.gitUrl')} value={url} spellCheck={false} autoComplete="off" disabled={busy} onChange={(event) => setUrl(event.target.value)} />
              <Button type="submit" disabled={url.trim() === ''} isLoading={busy}>{t('workspaceImport.clone')}</Button>
            </div>
            <p className="import-workspace-hint">{t('workspaceImport.gitHint')}</p>
          </form>
        )}
        {untrustedPath !== null && (
          <div className="import-workspace-untrusted">
            <InlineAlert>{t('workspaceImport.untrustedFolder', { path: untrustedPath })}</InlineAlert>
            <Button variant="danger" disabled={busy} isLoading={action === 'trust'} onClick={() => void trustAndClone()}>{t('workspaceImport.trustAndClone')}</Button>
          </div>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
      </div>
    </Modal>
  )
}
