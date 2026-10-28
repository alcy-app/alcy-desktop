import { useEffect, useState } from 'react'
import type { GitlabCommandError } from '../../bindings/gitlab-types'
import { getOnedriveRoot } from '../../bindings/get-onedrive-root'
import { listOnedriveFolders } from '../../bindings/list-onedrive-folders'
import type { DriveFolderDto } from '../../bindings/onedrive-types'
import { resolveOnedriveShareLink } from '../../bindings/resolve-onedrive-share-link'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { useOnedrive } from '../../shared/onedrive/use-onedrive'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { Select } from '../../shared/ui/Select'
import { ChevronRightIcon, FolderIcon } from '../../shared/ui/icons'
import type { LinkParams } from './use-version-control'

type Source = 'browse' | 'shareLink'

interface FolderListing {
  key: string
  items: DriveFolderDto[]
  nextLink: string | null
  error: GitlabCommandError | null
}

interface OnedriveLinkFormProps {
  busy: boolean
  error: string | null
  onSubmit: (params: LinkParams) => void
  onCancelBusy: () => void
}

const folderKey = (folder: DriveFolderDto) => `${folder.driveId}/${folder.id}`

/**
 * Choice of the OneDrive/SharePoint folder that will hold the workspace files:
 * browse the account's own drive, or paste a sharing link for a folder shared
 * by someone else (including SharePoint and Teams).
 */
export function OnedriveLinkForm({ busy, error, onSubmit, onCancelBusy }: OnedriveLinkFormProps) {
  const { t } = useLanguage()
  const { accounts } = useOnedrive()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [source, setSource] = useState<Source>('browse')
  const [trail, setTrail] = useState<{ accountId: string; folders: DriveFolderDto[]; error: GitlabCommandError | null } | null>(null)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [shareLink, setShareLink] = useState('')
  const [shared, setShared] = useState<{ folder: DriveFolderDto | null; error: GitlabCommandError | null } | null>(null)
  const [resolving, setResolving] = useState(false)
  const [includeEnvironments, setIncludeEnvironments] = useState(false)

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    void getOnedriveRoot(crypto.randomUUID(), accountId).then((result) => {
      if (cancelled) return
      setTrail(result.ok ? { accountId, folders: [result.value], error: null } : { accountId, folders: [], error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [accountId])

  const folders = trail?.accountId === accountId ? trail.folders : []
  const current = folders.at(-1) ?? null
  const currentKey = current ? folderKey(current) : ''

  useEffect(() => {
    if (!current) return
    let cancelled = false
    const key = folderKey(current)
    void listOnedriveFolders({ operationId: crypto.randomUUID(), accountId, driveId: current.driveId, folderId: current.id }).then((result) => {
      if (cancelled) return
      setListing(result.ok
        ? { key, items: result.value.items, nextLink: result.value.nextLink, error: null }
        : { key, items: [], nextLink: null, error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [accountId, current])

  const folderListing = listing?.key === currentKey ? listing : null
  const listingLoading = current !== null && folderListing === null

  const loadMore = async () => {
    if (!current || !folderListing?.nextLink) return
    setLoadingMore(true)
    const result = await listOnedriveFolders({
      operationId: crypto.randomUUID(),
      accountId,
      driveId: current.driveId,
      folderId: current.id,
      nextLink: folderListing.nextLink,
    })
    setLoadingMore(false)
    setListing(result.ok
      ? { ...folderListing, items: [...folderListing.items, ...result.value.items], nextLink: result.value.nextLink }
      : { ...folderListing, error: result.error })
  }

  const resolveLink = async () => {
    const link = shareLink.trim()
    if (!link) return
    setResolving(true)
    const result = await resolveOnedriveShareLink(crypto.randomUUID(), accountId, link)
    setResolving(false)
    setShared(result.ok ? { folder: result.value, error: null } : { folder: null, error: result.error })
  }

  // The drive root is not offered as a target: the workspace files would mix
  // with everything else in it.
  const target = source === 'browse' ? (folders.length > 1 ? current : null) : shared?.folder ?? null
  const canSubmit = target !== null && !busy

  const submit = () => {
    if (!target) return
    onSubmit({ provider: 'onedrive', accountId, driveId: target.driveId, folderId: target.id, includeEnvironments })
  }

  return (
    <form
      className="vc-link-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) submit()
      }}
    >
      <h3 className="vc-section-title">{t('vc.link.title')}</h3>

      {accounts.length > 1 && (
        <Field label={t('vc.link.account')}>
          {(id) => (
            <Select
              id={id}
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value)
                setShared(null)
              }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.username}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <SegmentedControl<Source>
        ariaLabel={t('vc.onedrive.sourceLabel')}
        value={source}
        onChange={setSource}
        layout="inline"
        size="sm"
        options={[
          { value: 'browse', label: t('vc.onedrive.browse') },
          { value: 'shareLink', label: t('vc.onedrive.shareLink') },
        ]}
      />

      {source === 'browse' && (
        <>
          {trail?.error && <InlineAlert>{gitlabErrorMessage(trail.error, t)}</InlineAlert>}
          {folders.length > 0 && (
            <nav className="vc-folder-trail" aria-label={t('vc.onedrive.trail')}>
              {folders.map((folder, index) => (
                <span key={folderKey(folder)} className="vc-folder-trail-step">
                  {index > 0 && <ChevronRightIcon size={11} />}
                  <button
                    type="button"
                    aria-current={index === folders.length - 1 ? 'location' : undefined}
                    onClick={() => setTrail({ accountId, folders: folders.slice(0, index + 1), error: null })}
                  >
                    {index === 0 ? t('vc.onedrive.root') : folder.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
          <div className="vc-project-list" role="group" aria-label={t('vc.onedrive.folders')} aria-busy={listingLoading}>
            {(listingLoading || (!trail && accountId)) && <p className="vc-muted">{t('vc.onedrive.loading')}</p>}
            {folderListing?.error && <InlineAlert>{gitlabErrorMessage(folderListing.error, t)}</InlineAlert>}
            {folderListing && !folderListing.error && folderListing.items.length === 0 && <p className="vc-muted">{t('vc.onedrive.noFolders')}</p>}
            {folderListing?.items.map((folder) => (
              <button
                key={folderKey(folder)}
                type="button"
                className="vc-project-option vc-folder-option"
                onClick={() => setTrail({ accountId, folders: [...folders, folder], error: null })}
              >
                <FolderIcon size={13} />
                <span>{folder.name}</span>
              </button>
            ))}
            {folderListing?.nextLink && (
              <Button variant="ghost" isLoading={loadingMore} onClick={() => void loadMore()}>
                {t('vc.link.loadMore')}
              </Button>
            )}
          </div>
          <p className="vc-muted" role="status">
            {folders.length > 1 && current ? t('vc.onedrive.selected', { path: current.path }) : t('vc.onedrive.pickFolder')}
          </p>
        </>
      )}

      {source === 'shareLink' && (
        <>
          <Field label={t('vc.onedrive.shareLinkLabel')}>
            {(id) => (
              <div className="vc-share-link-row">
                <Input
                  id={id}
                  mono
                  type="url"
                  value={shareLink}
                  placeholder="https://…sharepoint.com/:f:/…"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    setShareLink(event.target.value)
                    setShared(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void resolveLink()
                    }
                  }}
                />
                <Button variant="ghost" isLoading={resolving} disabled={shareLink.trim() === ''} onClick={() => void resolveLink()}>
                  {t('vc.onedrive.openLink')}
                </Button>
              </div>
            )}
          </Field>
          <p className="vc-muted">{t('vc.onedrive.shareLinkHint')}</p>
          {shared?.error && <InlineAlert>{gitlabErrorMessage(shared.error, t)}</InlineAlert>}
          {shared?.folder && <p className="vc-muted" role="status">{t('vc.onedrive.selected', { path: shared.folder.path })}</p>}
        </>
      )}

      <label className="vc-checkbox-row">
        <Checkbox checked={includeEnvironments} onChange={(event) => setIncludeEnvironments(event.target.checked)} />
        <span>
          {t('vc.link.includeEnvironments')}
          <span className="vc-muted vc-checkbox-hint">{t('vc.link.includeEnvironmentsHint')}</span>
        </span>
      </label>

      {error && <InlineAlert>{error}</InlineAlert>}

      <div className="vc-actions">
        {busy && (
          <Button variant="ghost" onClick={onCancelBusy}>
            {t('gitlab.cancel')}
          </Button>
        )}
        <Button type="submit" disabled={!canSubmit} isLoading={busy}>
          {t('vc.link.submit')}
        </Button>
      </div>
    </form>
  )
}
