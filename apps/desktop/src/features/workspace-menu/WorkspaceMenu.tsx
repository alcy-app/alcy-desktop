import { useEffect, useId, useRef } from 'react'
import type { WorkspaceDto } from '../../bindings/create-workspace'
import type { RecentWorkspaceDto } from '../../bindings/list-recent-workspaces'
import { useLanguage } from '../../shared/i18n/use-language'
import { ImportWorkspaceDialog } from '../../shared/workspace-import/ImportWorkspaceDialog'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { MenuItem, OptionsMenu } from '../../shared/ui/Menu'
import { ChevronDownIcon, CloseIcon, FolderIcon, GitIcon, LockIcon, PencilIcon, WorkspaceIcon } from '../../shared/ui/icons'
import { useTooltip } from '../../shared/ui/use-tooltip'
import { workspaceErrorMessageKey } from '../../shared/workspace-command-error'
import { useWorkspaceMenuState } from './use-workspace-menu-state'
import { folderNameOf } from './workspace-folder'
import { WorkspaceRenamePanel } from './WorkspaceRenamePanel'
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

  const renameStep = state.pendingRename ? (state.pendingRename.target ?? 'choose') : null

  useEffect(() => {
    if (!state.isOpen) return
    const activeItem = contentRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
    const firstFocusable = contentRef.current?.querySelector<HTMLElement>('input, button:not(:disabled)')
    ;(activeItem ?? firstFocusable)?.focus()
  }, [state.isOpen, state.pendingRemoval, renameStep])

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
        {state.pendingRename ? (
          <WorkspaceRenamePanel
            entry={state.pendingRename.entry}
            target={state.pendingRename.target}
            isCurrent={state.pendingRename.entry.rootPath === currentWorkspace.rootPath}
            isSubmitting={state.busy === 'renaming'}
            error={state.error}
            onChooseTarget={state.chooseRenameTarget}
            onBack={state.backToRenameChoice}
            onCancel={state.cancelRename}
            onSubmit={(draft) => void state.commitRename(draft)}
          />
        ) : state.pendingRemoval ? (
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
              busy={busy}
              onSwitch={() => void state.switchToRecent(entry.rootPath)}
              onOpenFolder={() => void state.openFolder(entry.rootPath)}
              onStartRename={() => state.startRename(entry)}
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
  busy: boolean
  onSwitch: () => void
  onOpenFolder: () => void
  onStartRename: () => void
  onRemove: () => void
}

function WorkspaceListItem({ entry, isCurrent, busy, onSwitch, onOpenFolder, onStartRename, onRemove }: WorkspaceListItemProps) {
  const { t } = useLanguage()
  const folderName = folderNameOf(entry.rootPath)
  const { triggerProps: folderTooltipProps, tooltip: folderTooltip } = useTooltip(entry.rootPath)
  const cardClassName = [
    'ws-menu-item-card',
    isCurrent ? 'ws-menu-item-card--active' : null,
    busy ? 'ws-menu-item-card--busy' : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className="ws-menu-item">
      {/* Two sibling buttons: the switch one stretches over the card, the folder one sits above it. */}
      <div className={cardClassName}>
        <button type="button" className="ws-menu-item-button" onClick={onSwitch} disabled={busy} aria-current={isCurrent}>
          {entry.linked && (
            <span className="ws-menu-item-git" title={t('workspaceMenu.scope.remote')}>
              <GitIcon size={11} />
            </span>
          )}
          <span className="ws-menu-item-name">{entry.name}</span>
        </button>
        <button
          type="button"
          className="ws-menu-item-folder"
          onClick={onOpenFolder}
          disabled={busy}
          aria-label={t('workspaceMenu.openFolderAria', { folder: folderName })}
          {...folderTooltipProps}
        >
          <FolderIcon size={11} />
          <span className="ws-menu-item-folder-name">{folderName}</span>
        </button>
        {folderTooltip}
      </div>
      <div className="ws-menu-item-actions">
        <IconButton
          icon={<PencilIcon size={12} />}
          onClick={onStartRename}
          disabled={busy}
          label={t('workspaceMenu.renameAria', { name: entry.name })}
        />
        <IconButton
          variant="danger"
          icon={<CloseIcon size={12} />}
          onClick={onRemove}
          disabled={busy}
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
