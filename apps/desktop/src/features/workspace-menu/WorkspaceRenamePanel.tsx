import { useId, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import type { WorkspaceCommandError } from '../../bindings/create-workspace'
import type { RecentWorkspaceDto } from '../../bindings/list-recent-workspaces'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { FolderIcon, TagIcon } from '../../shared/ui/icons'
import { workspaceErrorMessageKey } from '../../shared/workspace-command-error'
import type { WorkspaceRenameTarget } from './use-workspace-menu-state'
import { folderNameOf, withFolderName } from './workspace-folder'

interface WorkspaceRenamePanelProps {
  entry: RecentWorkspaceDto
  target: WorkspaceRenameTarget | null
  isCurrent: boolean
  isSubmitting: boolean
  error: WorkspaceCommandError | null
  onChooseTarget: (target: WorkspaceRenameTarget) => void
  onBack: () => void
  onCancel: () => void
  onSubmit: (draft: string) => void
}

/** Asks what to rename, then takes the new name, inside the workspace dropdown. */
export function WorkspaceRenamePanel({
  entry,
  target,
  isCurrent,
  isSubmitting,
  error,
  onChooseTarget,
  onBack,
  onCancel,
  onSubmit,
}: WorkspaceRenamePanelProps) {
  const { t } = useLanguage()

  // Stops here so that Escape walks back one step instead of closing the menu.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (isSubmitting) return
    if (target) onBack()
    else onCancel()
  }

  return (
    <div className="ws-menu-confirm" onKeyDown={handleKeyDown}>
      <p className="ws-menu-confirm-title">{t('workspaceMenu.renameTitle', { name: entry.name })}</p>

      {error && (
        <InlineAlert className="ws-menu-error">{t(workspaceErrorMessageKey(error), { message: error.message })}</InlineAlert>
      )}

      {target ? (
        <RenameForm
          entry={entry}
          target={target}
          isCurrent={isCurrent}
          isSubmitting={isSubmitting}
          onBack={onBack}
          onSubmit={onSubmit}
        />
      ) : (
        <>
          <RenameOption
            icon={<TagIcon size={14} />}
            label={t('workspaceMenu.renameAlias')}
            hint={t('workspaceMenu.renameAliasHint')}
            onSelect={() => onChooseTarget('alias')}
          />
          <RenameOption
            icon={<FolderIcon size={14} />}
            label={t('workspaceMenu.renameFolder')}
            hint={t('workspaceMenu.renameFolderHint', { folder: folderNameOf(entry.rootPath) })}
            onSelect={() => onChooseTarget('folder')}
          />
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </>
      )}
    </div>
  )
}

interface RenameOptionProps {
  icon: ReactNode
  label: string
  hint: string
  onSelect: () => void
}

function RenameOption({ icon, label, hint, onSelect }: RenameOptionProps) {
  const hintId = useId()

  return (
    <button type="button" className="ws-menu-confirm-option ws-menu-rename-option" onClick={onSelect} aria-label={label} aria-describedby={hintId}>
      <span className="ws-menu-rename-option-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ws-menu-rename-option-text">
        <span className="ws-menu-confirm-option-label" aria-hidden="true">
          {label}
        </span>
        <span className="ws-menu-confirm-option-hint" id={hintId}>
          {hint}
        </span>
      </span>
    </button>
  )
}

interface RenameFormProps {
  entry: RecentWorkspaceDto
  target: WorkspaceRenameTarget
  isCurrent: boolean
  isSubmitting: boolean
  onBack: () => void
  onSubmit: (draft: string) => void
}

function RenameForm({ entry, target, isCurrent, isSubmitting, onBack, onSubmit }: RenameFormProps) {
  const { t } = useLanguage()
  const isFolder = target === 'folder'
  const currentName = isFolder ? folderNameOf(entry.rootPath) : entry.name
  const [draft, setDraft] = useState(currentName)
  const name = draft.trim()
  const canSubmit = name !== '' && name !== currentName

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSubmit && !isSubmitting) onSubmit(draft)
  }

  return (
    <form className="ws-menu-rename-form" onSubmit={submit}>
      <Field label={t(isFolder ? 'workspaceMenu.renameFolderLabel' : 'workspaceMenu.renameAliasLabel')}>
        {(id) => (
          <Input
            id={id}
            value={draft}
            readOnly={isSubmitting}
            mono={isFolder}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
      </Field>

      {isFolder && (
        <p className="ws-menu-rename-preview">
          {withFolderName(entry.rootPath, name || currentName)}
        </p>
      )}
      {isFolder && isCurrent && <p className="ws-menu-confirm-hint">{t('workspaceMenu.renameFolderReloadHint')}</p>}

      <div className="ws-menu-rename-actions">
        <Button variant="ghost" onClick={onBack} disabled={isSubmitting}>
          {t('workspaceMenu.renameBack')}
        </Button>
        {/* Not disabled while submitting: a disabled button drops focus, and the menu closes on blur. */}
        <Button type="submit" disabled={!canSubmit} aria-busy={isSubmitting || undefined}>
          {isSubmitting ? t('workspaceMenu.renaming') : t('workspaceMenu.renameSubmit')}
        </Button>
      </div>
    </form>
  )
}
