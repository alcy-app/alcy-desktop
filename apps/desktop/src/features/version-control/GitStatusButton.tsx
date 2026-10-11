import { useState, type ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { ChevronDownIcon, GitIcon, GitPullIcon, GitPushIcon, RefreshIcon, Spinner } from '../../shared/ui/icons'
import { OptionsMenu } from '../../shared/ui/Menu'
import type { WorkspaceLinkDto } from '../../bindings/gitlab-types'
import type { VersionCounts, VersionSummary } from './version-summary'
import type { VersionBusy } from './use-version-control'

interface GitStatusButtonProps {
  summary: VersionSummary
  counts: VersionCounts
  link: WorkspaceLinkDto | null
  checking: boolean
  busy: VersionBusy | null
  onOpenPanel: () => void
  onPull: () => void
  onRefresh: () => void
}

/** Estado e ações rápidas de Git no canto inferior direito. */
export function GitStatusButton({ summary, counts, link, checking, busy, onOpenPanel, onPull, onRefresh }: GitStatusButtonProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const branch = link?.branch ?? ''

  const description = (() => {
    switch (summary) {
      case 'unlinked':
        return t('vc.status.unlinked')
      case 'loading':
        return t('vc.status.loading')
      case 'busy':
        return t('vc.status.busy')
      case 'error':
        return t('vc.status.error')
      case 'clean':
        return t('vc.status.clean', { branch })
      case 'changes':
        return t('vc.status.changes', { count: counts.local, branch })
      case 'remoteAhead':
        return t('vc.status.remoteAhead', { branch })
      case 'conflict':
        return t('vc.status.conflict', { branch })
    }
  })()

  const badge = summary === 'changes' ? counts.local : summary === 'conflict' ? counts.conflicts : null
  const linked = link !== null
  const working = busy !== null
  const closeAndRun = (action: () => void) => {
    setOpen(false)
    action()
  }

  const trigger = <>
    <GitIcon size={14} />
    <span className="rw-statusbar-label">{branch || t('vc.statusbar.label')}</span>
    {badge !== null && <span className="rw-statusbar-count">{badge}</span>}
    {(summary === 'clean' || summary === 'remoteAhead' || summary === 'error') && (
      <span className="rw-statusbar-git-dot" aria-hidden="true" />
    )}
    <ChevronDownIcon size={11} />
  </>

  return (
    <OptionsMenu
      label={t('vc.statusbar.aria', { summary: description })}
      isOpen={open}
      onToggle={() => setOpen((value) => !value)}
      onClose={() => setOpen(false)}
      icon={trigger}
      wrapperClassName="rw-statusbar-git-host"
      buttonClassName="rw-statusbar-git"
      buttonDataState={summary}
      menuClassName="rw-statusbar-git-menu"
    >
      <GitMenuAction icon={checking ? <Spinner size={13} /> : <RefreshIcon size={13} />} label={t('vc.quick.check')} disabled={!linked || working} onClick={() => closeAndRun(onRefresh)} />
      <GitMenuAction icon={busy === 'pull' ? <Spinner size={13} /> : <GitPullIcon size={13} />} label={t('vc.quick.pull')} disabled={!linked || working} onClick={() => closeAndRun(onPull)} />
      <GitMenuAction icon={<GitPushIcon size={13} />} label={t('vc.quick.push')} disabled={working} onClick={() => closeAndRun(onOpenPanel)} />
    </OptionsMenu>
  )
}

function GitMenuAction({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled: boolean; onClick: () => void }) {
  return <button type="button" role="menuitem" className="ui-menu-item rw-statusbar-git-action" disabled={disabled} onClick={onClick}>{icon}<span>{label}</span></button>
}
