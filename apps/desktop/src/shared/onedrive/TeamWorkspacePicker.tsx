import { useEffect, useState } from 'react'
import { createOnedriveTeamWorkspace } from '../../bindings/create-onedrive-team-workspace'
import { getOnedriveTeamCatalog } from '../../bindings/get-onedrive-team-catalog'
import type { GitlabCommandError } from '../../bindings/gitlab-types'
import { listOnedriveFolders } from '../../bindings/list-onedrive-folders'
import { listOnedriveTeams } from '../../bindings/list-onedrive-teams'
import type { DriveFolderDto, TeamDto } from '../../bindings/onedrive-types'
import { gitlabErrorMessage } from '../gitlab/gitlab-error-message'
import { useLanguage } from '../i18n/use-language'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { InlineAlert } from '../ui/InlineAlert'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { FolderIcon } from '../ui/icons'
import './team-workspace-picker.css'

/** Pages of a team's catalog read at once (100 workspaces per page). */
const MAX_CATALOG_PAGES = 5

interface TeamsState {
  accountId: string
  items: TeamDto[]
  error: GitlabCommandError | null
}

interface CatalogState {
  teamId: string
  workspaces: DriveFolderDto[]
  error: GitlabCommandError | null
}

interface TeamWorkspacePickerProps {
  accountId: string
  selected: DriveFolderDto | null
  onSelect: (folder: DriveFolderDto | null) => void
  /** Offers creating a new workspace folder in the chosen team. */
  allowCreate: boolean
}

/**
 * Workspaces of the account's Teams: the subfolders of `Alcy/` in each team's
 * library. Teams the account is not in never show up, because SharePoint does
 * not return them.
 */
export function TeamWorkspacePicker({ accountId, selected, onSelect, allowCreate }: TeamWorkspacePickerProps) {
  const { t } = useLanguage()
  const [teams, setTeams] = useState<TeamsState | null>(null)
  const [chosenTeam, setChosenTeam] = useState('')
  const [catalog, setCatalog] = useState<CatalogState | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<GitlabCommandError | null>(null)

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    void listOnedriveTeams(crypto.randomUUID(), accountId).then((result) => {
      if (cancelled) return
      setTeams(result.ok ? { accountId, items: result.value, error: null } : { accountId, items: [], error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [accountId])

  const teamList = teams?.accountId === accountId ? teams : null
  const teamId = teamList?.items.some((team) => team.id === chosenTeam) ? chosenTeam : teamList?.items[0]?.id ?? ''

  useEffect(() => {
    if (!accountId || !teamId) return
    let cancelled = false
    void (async () => {
      const result = await getOnedriveTeamCatalog(crypto.randomUUID(), accountId, teamId)
      if (cancelled) return
      if (!result.ok) {
        setCatalog({ teamId, workspaces: [], error: result.error })
        return
      }
      const folder = result.value.folder
      const workspaces: DriveFolderDto[] = []
      let nextLink: string | null | undefined
      for (let page = 0; folder && page < MAX_CATALOG_PAGES && nextLink !== null; page += 1) {
        const listed = await listOnedriveFolders({ operationId: crypto.randomUUID(), accountId, driveId: folder.driveId, folderId: folder.id, nextLink })
        if (cancelled) return
        if (!listed.ok) {
          setCatalog({ teamId, workspaces, error: listed.error })
          return
        }
        workspaces.push(...listed.value.items)
        nextLink = listed.value.nextLink
      }
      setCatalog({ teamId, workspaces, error: null })
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, teamId])

  const teamCatalog = catalog?.teamId === teamId ? catalog : null

  const create = async () => {
    const name = newName.trim()
    if (!name || !teamId) return
    setCreating(true)
    setCreateError(null)
    const result = await createOnedriveTeamWorkspace({ operationId: crypto.randomUUID(), accountId, teamId, name })
    setCreating(false)
    if (!result.ok) {
      setCreateError(result.error)
      return
    }
    setNewName('')
    setCatalog((current) => current?.teamId === teamId
      ? { ...current, workspaces: [...current.workspaces, result.value] }
      : current)
    onSelect(result.value)
  }

  if (teamList?.error) return <InlineAlert>{gitlabErrorMessage(teamList.error, t)}</InlineAlert>
  if (!teamList) return <p className="team-picker-muted" role="status">{t('vc.team.loadingTeams')}</p>
  if (teamList.items.length === 0) return <p className="team-picker-muted">{t('vc.team.noTeams')}</p>

  return (
    <>
      <Field label={t('vc.team.team')}>
        {(id) => (
          <Select
            id={id}
            value={teamId}
            onChange={(event) => {
              setChosenTeam(event.target.value)
              setCreateError(null)
              onSelect(null)
            }}
          >
            {teamList.items.map((team) => (
              <option key={team.id} value={team.id}>{team.name}</option>
            ))}
          </Select>
        )}
      </Field>

      <div className="team-picker-list" role="group" aria-label={t('vc.team.workspaces')} aria-busy={teamCatalog === null}>
        {teamCatalog === null && <p className="team-picker-muted">{t('vc.team.loadingWorkspaces')}</p>}
        {teamCatalog?.error && <InlineAlert>{gitlabErrorMessage(teamCatalog.error, t)}</InlineAlert>}
        {teamCatalog && !teamCatalog.error && teamCatalog.workspaces.length === 0 && <p className="team-picker-muted">{t('vc.team.noWorkspaces')}</p>}
        {teamCatalog?.workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            aria-pressed={selected?.driveId === workspace.driveId && selected.id === workspace.id}
            className="team-picker-option"
            onClick={() => onSelect(workspace)}
          >
            <FolderIcon size={13} />
            <span>{workspace.name}</span>
          </button>
        ))}
      </div>

      {allowCreate && (
        <Field label={t('vc.team.newWorkspace')}>
          {(id) => (
            <div className="team-picker-create">
              <Input
                id={id}
                value={newName}
                placeholder={t('vc.team.newWorkspacePlaceholder')}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => {
                  setNewName(event.target.value)
                  setCreateError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void create()
                  }
                }}
              />
              <Button variant="ghost" isLoading={creating} disabled={newName.trim() === ''} onClick={() => void create()}>
                {t('vc.team.create')}
              </Button>
            </div>
          )}
        </Field>
      )}
      {createError && <InlineAlert>{createError.kind === 'conflict' ? t('vc.team.nameTaken') : gitlabErrorMessage(createError, t)}</InlineAlert>}
    </>
  )
}
