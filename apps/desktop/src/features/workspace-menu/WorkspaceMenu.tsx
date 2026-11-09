import { useEffect, useId, useRef, useState } from 'react'
import type { WorkspaceDto } from '../../bindings/create-workspace'
import type { RecentWorkspaceDto } from '../../bindings/list-recent-workspaces'
import { useLanguage } from '../../shared/i18n/use-language'
import { ImportWorkspaceDialog } from '../../shared/workspace-import/ImportWorkspaceDialog'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { MenuItem, OptionsMenu } from '../../shared/ui/Menu'
import { ChevronDownIcon, CloseIcon, GitIcon, LockIcon, PencilIcon, WorkspaceIcon } from '../../shared/ui/icons'
import { workspaceErrorMessageKey } from '../../shared/workspace-command-error'
import { useWorkspaceMenuState } from './use-workspace-menu-state'
import './workspace-menu.css'

interface WorkspaceMenuProps {
  currentWorkspace: WorkspaceDto
  remoteLinked: boolean | null
  onWorkspaceChange: (workspace: WorkspaceDto) => void
  onExitToStartScreen: () => void
  onLocalChange?: () => void
}

/** Trocador de workspace: dropdown ancorado ao gatilho (não um modal central). */
export function WorkspaceMenu({
  currentWorkspace,
  remoteLinked,
  onWorkspaceChange,
  onExitToStartScreen,
  onLocalChange,
}: WorkspaceMenuProps) {
  const { t } = useLanguage()
  const state = useWorkspaceMenuState({ currentWorkspace, onWorkspaceChange, onExitToStartScreen, onLocalChange })
  const contentRef = useRef<HTMLDivElement>(null)
  const scopeLabel = t(remoteLinked === null ? 'workspaceMenu.scope.loading' : remoteLinked ? 'workspaceMenu.scope.remote' : 'workspaceMenu.scope.local')

  useEffect(() => {
    if (!state.isOpen) return
    const activeItem = contentRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
    const firstFocusable = contentRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
    ;(activeItem ?? firstFocusable)?.focus()
  }, [state.isOpen, state.pendingRemoval])

  return (
    <>
    <OptionsMenu
      label={t('workspaceMenu.triggerAria', { name: currentWorkspace.name, scope: scopeLabel })}
      isOpen={state.isOpen}
      onToggle={() => (state.isOpen ? state.close() : state.open())}
      onClose={state.pendingRemoval ? state.cancelRemoval : state.close}
      icon={
        <>
          <WorkspaceIcon size={15} />
          <span className="ws-menu-trigger-name">{currentWorkspace.name}</span>
          {remoteLinked !== null && (
            <span className="ws-menu-scope" data-scope={remoteLinked ? 'remote' : 'local'} title={scopeLabel}>
              {remoteLinked ? <GitIcon size={13} /> : <LockIcon size={12} />}
            </span>
          )}
          <ChevronDownIcon size={12} className="ws-menu-trigger-chevron" />
        </>
      }
      wrapperClassName="ws-menu-host"
      buttonClassName="ws-menu-trigger"
      menuClassName="ws-menu-dropdown"
    >
      <div ref={contentRef}>
        <p className="ws-menu-dropdown-title">{t('workspaceMenu.modalTitle')}</p>
        {state.pendingRemoval ? (
          <RemovalConfirmView entry={state.pendingRemoval} state={state} />
        ) : (
          <WorkspaceListView currentWorkspace={currentWorkspace} state={state} busy={state.busy !== 'idle'} />
        )}
      </div>
    </OptionsMenu>
    {state.importDialogOpen && <ImportWorkspaceDialog onClose={state.closeImportDialog} onWorkspaceReady={state.finishImport} />}
    </>
  )
}

interface WorkspaceListViewProps {
  currentWorkspace: WorkspaceDto
  state: ReturnType<typeof useWorkspaceMenuState>
  busy: boolean
}

function WorkspaceListView({ currentWorkspace, state, busy }: WorkspaceListViewProps) {
  const { t } = useLanguage()

  return (
    <>
      {state.error && (
        <InlineAlert className="ws-menu-error">
          {t(workspaceErrorMessageKey(state.error), { message: state.error.message })}
        </InlineAlert>
      )}

      {state.loaded ? (
        <ul className="ws-menu-list">
          {state.recents.map((entry) => (
            <WorkspaceListItem
              key={entry.rootPath}
              entry={entry}
              isCurrent={entry.rootPath === currentWorkspace.rootPath}
              isRenaming={entry.rootPath === state.renamingRootPath}
              busy={busy}
              onSwitch={() => void state.switchToRecent(entry.rootPath)}
              onStartRename={() => state.startRename(entry.rootPath)}
              onCommitRename={(draft) => void state.commitRename(entry, draft)}
              onCancelRename={state.cancelRename}
              onRemove={() => void state.requestRemoval(entry)}
            />
          ))}
        </ul>
      ) : (
        <p className="ws-menu-loading">{t('workspaceMenu.loading')}</p>
      )}

      <div className="ws-menu-divider" role="separator" />

      <MenuItem
        label={state.busy === 'creating' ? t('workspaceMenu.creating') : t('workspaceMenu.createButton')}
        disabled={busy}
        onSelect={() => void state.create()}
      />
      <MenuItem
        label={state.busy === 'importing' ? t('workspaceMenu.importing') : t('workspaceMenu.importButton')}
        disabled={busy}
        onSelect={() => void state.importExisting()}
      />
    </>
  )
}

interface WorkspaceListItemProps {
  entry: RecentWorkspaceDto
  isCurrent: boolean
  isRenaming: boolean
  busy: boolean
  onSwitch: () => void
  onStartRename: () => void
  onCommitRename: (draft: string) => void
  onCancelRename: () => void
  onRemove: () => void
}

function WorkspaceListItem({
  entry,
  isCurrent,
  isRenaming,
  busy,
  onSwitch,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRemove,
}: WorkspaceListItemProps) {
  const { t } = useLanguage()
  const [draft, setDraft] = useState(entry.name)
  const renameButtonRef = useRef<HTMLButtonElement>(null)
  const cancelledRef = useRef(false)

  const startRename = () => {
    setDraft(entry.name)
    cancelledRef.current = false
    onStartRename()
  }

  // Enter e Escape devolvem o foco ao lápis em vez de desmontar o input
  // focado: o foco continua dentro do menu (que fecha ao perder o foco) e o
  // blur resultante é o único ponto que encerra a edição.
  const finishRename = () => {
    if (cancelledRef.current) {
      onCancelRename()
    } else {
      onCommitRename(draft)
    }
  }

  return (
    <li className="ws-menu-item">
      {isRenaming ? (
        // Fora de um <button>: clicar num input aninhado em botão move o foco para o botão e encerra a edição.
        <div className="ws-menu-item-button ws-menu-item-button--renaming" aria-current={isCurrent}>
          <InlineEditInput
            value={draft}
            autoFocus
            aria-label={t('workspaceMenu.nameInputAria')}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                renameButtonRef.current?.focus()
              } else if (event.key === 'Escape') {
                // Sem isso o Escape chegaria ao menu e o fecharia junto.
                event.stopPropagation()
                cancelledRef.current = true
                renameButtonRef.current?.focus()
              }
            }}
          />
          <span className="ws-menu-item-path">{entry.rootPath}</span>
        </div>
      ) : (
        <button
          type="button"
          className={isCurrent ? 'ws-menu-item-button ws-menu-item-button--active' : 'ws-menu-item-button'}
          onClick={onSwitch}
          disabled={busy}
          aria-current={isCurrent}
        >
          <span className="ws-menu-item-name-row">
            {entry.linked && (
              <span className="ws-menu-item-git" title={t('workspaceMenu.scope.remote')}>
                <GitIcon size={11} />
              </span>
            )}
            <span className="ws-menu-item-name">{entry.name}</span>
          </span>
          <span className="ws-menu-item-path">{entry.rootPath}</span>
        </button>
      )}
      <div className="ws-menu-item-actions">
        <IconButton
          ref={renameButtonRef}
          icon={<PencilIcon size={12} />}
          onClick={isRenaming ? undefined : startRename}
          disabled={busy}
          label={t('workspaceMenu.renameAria', { name: entry.name })}
        />
        <IconButton
          variant="danger"
          icon={<CloseIcon size={12} />}
          onClick={onRemove}
          disabled={busy || isRenaming}
          label={t('workspaceMenu.removeAria', { name: entry.name })}
        />
      </div>
    </li>
  )
}

interface RemovalConfirmViewProps {
  entry: RecentWorkspaceDto
  state: ReturnType<typeof useWorkspaceMenuState>
}

function RemovalConfirmView({ entry, state }: RemovalConfirmViewProps) {
  const { t } = useLanguage()
  const busy = state.busy !== 'idle'
  const options = state.removalOptions
  const forgetHintId = useId()
  const deleteHintId = useId()

  return (
    <div className="ws-menu-confirm">
      <p className="ws-menu-confirm-title">{t('workspaceMenu.confirmTitle', { name: entry.name })}</p>

      {state.error && (
        <InlineAlert className="ws-menu-error">
          {t(workspaceErrorMessageKey(state.error), { message: state.error.message })}
        </InlineAlert>
      )}

      <button
        type="button"
        className="ws-menu-confirm-option"
        onClick={() => void state.confirmRemoval(false)}
        disabled={busy}
        aria-label={t('workspaceMenu.confirmForgetOnly')}
        aria-describedby={forgetHintId}
      >
        <span className="ws-menu-confirm-option-label" aria-hidden="true">
          {t('workspaceMenu.confirmForgetOnly')}
        </span>
        <span className="ws-menu-confirm-option-hint" id={forgetHintId}>
          {t('workspaceMenu.confirmForgetOnlyHint', { path: entry.rootPath })}
        </span>
      </button>

      {options === null || options.canDeleteFiles ? (
        <button
          type="button"
          className="ws-menu-confirm-option ws-menu-confirm-option--danger"
          onClick={() => void state.confirmRemoval(true)}
          aria-label={t('workspaceMenu.confirmDeleteFiles')}
          aria-describedby={deleteHintId}
          disabled={busy || options === null}
        >
          <span className="ws-menu-confirm-option-label" aria-hidden="true">
            {t('workspaceMenu.confirmDeleteFiles')}
          </span>
          <span className="ws-menu-confirm-option-hint" id={deleteHintId}>
            {t('workspaceMenu.confirmDeleteFilesHint')}
          </span>
        </button>
      ) : (
        <p className="ws-menu-confirm-hint">
          {options.ownerName === null
            ? t('workspaceMenu.confirmOwnerUnknown')
            : t('workspaceMenu.confirmOwnerOnly', { owner: options.ownerName })}
        </p>
      )}

      <Button variant="ghost" onClick={state.cancelRemoval} disabled={busy}>
        {t('common.cancel')}
      </Button>

      {state.busy === 'removing' && <p className="ws-menu-confirm-hint">{t('workspaceMenu.removing')}</p>}
    </div>
  )
}
