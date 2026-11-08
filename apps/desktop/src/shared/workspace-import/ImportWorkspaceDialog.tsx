import { useRef, useState } from 'react'
import { cancelVersionControlOperation } from '../../bindings/cancel-version-control-operation'
import type { WorkspaceDto } from '../../bindings/create-workspace'
import { cloneGitWorkspace } from '../../bindings/local-git'
import { openWorkspace } from '../../bindings/open-workspace'
import { pickWorkspaceFolder } from '../../bindings/pick-workspace-folder'
import { versionControlErrorMessage } from '../version-control-error-message'
import { useLanguage } from '../i18n/use-language'
import { Button } from '../ui/Button'
import { InlineAlert } from '../ui/InlineAlert'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { Tabs } from '../ui/Tabs'
import { workspaceErrorMessageKey } from '../workspace-command-error'
import './import-workspace-dialog.css'

type Source = 'folder' | 'git'

interface ImportWorkspaceDialogProps {
  onClose: () => void
  onWorkspaceReady: (workspace: WorkspaceDto) => void
}

/** Brings in an existing workspace, from a folder on this computer or a git repository. */
export function ImportWorkspaceDialog({ onClose, onWorkspaceReady }: ImportWorkspaceDialogProps) {
  const { t } = useLanguage()
  const [source, setSource] = useState<Source>('folder')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cloneRef = useRef<string | null>(null)

  const openFolder = async () => {
    const rootPath = await pickWorkspaceFolder()
    if (rootPath === null) return
    setBusy(true)
    setError(null)
    const result = await openWorkspace({ rootPath })
    setBusy(false)
    if (result.ok) onWorkspaceReady(result.value)
    else setError(t(workspaceErrorMessageKey(result.error), { message: result.error.message }))
  }
  const clone = async () => {
    const operationId = crypto.randomUUID()
    cloneRef.current = operationId
    setBusy(true)
    setError(null)
    const result = await cloneGitWorkspace({ operationId, url: url.trim() })
    cloneRef.current = null
    setBusy(false)
    if (result.ok) onWorkspaceReady(result.value)
    else if (result.error.kind !== 'cancelled') setError(versionControlErrorMessage(result.error, t))
  }
  const close = () => {
    if (cloneRef.current) void cancelVersionControlOperation(cloneRef.current)
    onClose()
  }
  const choose = (next: Source) => {
    if (busy) return
    setSource(next)
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
            <p className="import-workspace-hint">{t('workspaceImport.folderHint')}</p>
            <Button disabled={busy} isLoading={busy} onClick={() => void openFolder()}>{t('workspaceImport.chooseFolder')}</Button>
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
        {error && <InlineAlert>{error}</InlineAlert>}
      </div>
    </Modal>
  )
}
