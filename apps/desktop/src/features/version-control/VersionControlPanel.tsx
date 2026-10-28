import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cancelGitlabOperation } from '../../bindings/cancel-gitlab-operation'
import { getStructuredFileChanges } from '../../bindings/get-structured-file-changes'
import type { ChangedItemDto, FileState, FileStatusDto, StructuredFileChangesDto } from '../../bindings/gitlab-types'
import { gitlabErrorMessage } from '../../shared/gitlab/gitlab-error-message'
import { useGitlab } from '../../shared/gitlab/use-gitlab'
import { useLanguage } from '../../shared/i18n/use-language'
import { useOnedrive } from '../../shared/onedrive/use-onedrive'
import { Button } from '../../shared/ui/Button'
import { EmptyState } from '../../shared/ui/EmptyState'
import { BranchIcon, ChevronDownIcon, ChevronRightIcon, EllipsisIcon, FlowIcon, FolderIcon, GitIcon, GitPullIcon, MonitorIcon, RefreshIcon, SendIcon, Spinner, VariablesIcon } from '../../shared/ui/icons'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Modal } from '../../shared/ui/Modal'
import { SegmentedControl } from '../../shared/ui/SegmentedControl'
import { useTooltip } from '../../shared/ui/use-tooltip'
import { LinkWorkspaceForm } from './LinkWorkspaceForm'
import { OnedriveLinkForm } from './OnedriveLinkForm'
import { DiffView } from './DiffView'
import { FILE_LABELS, itemKindLabelKey } from './file-labels'
import { remoteLocation } from './remote-label'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import type { LinkParams, VersionControl } from './use-version-control'
import './version-control.css'

const DETAIL_PAGE_SIZE = 200
/** Required by the shared push command; the OneDrive provider ignores it. */
const ONEDRIVE_PUSH_MESSAGE = 'Alcy'

type Provider = 'gitlab' | 'onedrive'

const STATE_MARKERS: Record<FileState, string> = { clean: '', localAdded: 'A', localModified: 'M', localDeleted: 'D', remoteChanged: '↓', conflict: '!' }

type SectionKind = 'upcoming' | 'staged' | 'changes'
type CollapsibleSection = 'conflicts' | SectionKind

type DetailEntry = { key: string; value: StructuredFileChangesDto }
type DetailRequest = { key: string; operationId: string; promise: Promise<StructuredFileChangesDto | null> }

export interface VersionReviewTarget {
  fileName: string
  fileLabel: string
  changes: StructuredFileChangesDto
  item: ChangedItemDto | null
  direction?: 'outgoing' | 'incoming'
}

interface VersionControlPanelProps {
  rootPath: string
  vc: VersionControl
  onClose?: () => void
  onOpenSettings: () => void
  onReview?: (target: VersionReviewTarget) => void
  onPull: () => void
  onResolveConflict: (fileName: string, changes: StructuredFileChangesDto) => void
  embedded?: boolean
}

export function VersionControlPanel(props: VersionControlPanelProps) {
  const { t } = useLanguage()
  const gitlab = useGitlab()
  const onedrive = useOnedrive()
  const accountsLoaded = gitlab.loaded && onedrive.loaded
  const providers: Provider[] = [
    ...(FEATURE_FLAGS.gitlab && gitlab.accounts.length > 0 ? ['gitlab' as const] : []),
    ...(FEATURE_FLAGS.onedrive && onedrive.accounts.length > 0 ? ['onedrive' as const] : []),
  ]
  const body = !props.vc.linkLoaded || !accountsLoaded ? (
    <p className="vc-muted" role="status">{t('vc.panel.loading')}</p>
  ) : props.vc.link === null ? (
    providers.length === 0 ? (
      <EmptyState icon={<GitIcon size={28} />} title={t('vc.panel.noAccountTitle')} description={t('vc.panel.noAccountDescription')} action={<Button onClick={props.onOpenSettings}>{t('vc.panel.openSettings')}</Button>} />
    ) : (
      <LinkWorkspaceChooser providers={providers} vc={props.vc} />
    )
  ) : <LinkedView {...props} />

  if (props.embedded) {
    // In the sidebar the linked view pins its repository header over a scrolling
    // body; the other states (loading, no account, link form) scroll as a whole.
    const linked = props.vc.linkLoaded && accountsLoaded && props.vc.link !== null
    return <div className="vc-sidebar-panel sidebar-panel-layout">{linked ? body : <div className="sidebar-panel-scroll">{body}</div>}</div>
  }
  return <Modal title={t('vc.panel.title')} closeAriaLabel={t('vc.panel.close')} onClose={props.onClose ?? (() => {})} className="vc-modal">{body}</Modal>
}

/** Link form of the chosen provider; the choice only shows when both have accounts. */
function LinkWorkspaceChooser({ providers, vc }: { providers: Provider[]; vc: VersionControl }) {
  const { t } = useLanguage()
  const [chosen, setChosen] = useState<Provider>(providers[0])
  const provider = providers.includes(chosen) ? chosen : providers[0]
  const formProps = {
    busy: vc.busy === 'link',
    error: vc.error ? gitlabErrorMessage(vc.error, t) : null,
    onSubmit: (params: LinkParams) => void vc.linkTo(params),
    onCancelBusy: vc.cancel,
  }
  return <div className="vc-link-form">
    {providers.length > 1 && <SegmentedControl<Provider>
      ariaLabel={t('vc.link.provider')}
      value={provider}
      onChange={setChosen}
      layout="inline"
      size="sm"
      options={[{ value: 'gitlab', label: 'GitLab' }, { value: 'onedrive', label: 'OneDrive' }]}
    />}
    {provider === 'gitlab' ? <LinkWorkspaceForm {...formProps} /> : <OnedriveLinkForm {...formProps} />}
  </div>
}

function LinkedView({ rootPath, vc, onReview, onPull, onResolveConflict }: VersionControlPanelProps) {
  const { t } = useLanguage()
  const [detailEntries, setDetailEntries] = useState<Record<string, DetailEntry>>({})
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<CollapsibleSection>>(new Set())
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreTooltip = useTooltip(t('vc.action.more'), { enabled: !menuOpen })
  const [inlineReview, setInlineReview] = useState<{ name: string; direction: 'outgoing' | 'incoming' } | null>(null)
  const detailRequests = useRef(new Map<string, DetailRequest>())
  const detailFiles = useMemo(() => vc.files.filter((file) => file.state !== 'clean'), [vc.files])
  const detailKeys = useMemo(() => Object.fromEntries(detailFiles.map((file) => [
    file.name,
    `${rootPath}:${file.name}:${file.state}:${file.localRevision ?? `status-${vc.statusVersion}`}:${file.remoteRevision ?? ''}`,
  ])), [detailFiles, rootPath, vc.statusVersion])
  const details = useMemo(() => Object.fromEntries(Object.entries(detailEntries)
    .filter(([name, entry]) => entry.key === detailKeys[name])
    .map(([name, entry]) => [name, entry.value])), [detailEntries, detailKeys])

  const loadDetail = useCallback((fileName: string): Promise<StructuredFileChangesDto | null> => {
    const detailKey = detailKeys[fileName] ?? `${rootPath}:${fileName}:unknown`
    const cached = detailEntries[fileName]
    if (cached?.key === detailKey) return Promise.resolve(cached.value)
    const requestKey = `${detailKey}:request`
    const active = detailRequests.current.get(fileName)
    if (active?.key === requestKey) return active.promise
    if (active) void cancelGitlabOperation(active.operationId)
    const operationId = crypto.randomUUID()
    setDetailLoading((current) => new Set(current).add(requestKey))
    const fileStatus = vc.files.find((file) => file.name === fileName)
    const promise = getStructuredFileChanges(rootPath, operationId, fileName, fileStatus?.remoteRevision, fileStatus?.localRevision).then((result) => {
      setDetailLoading((loading) => {
        const next = new Set(loading)
        next.delete(requestKey)
        return next
      })
      const current = detailRequests.current.get(fileName)
      if (current?.key !== requestKey) return null
      detailRequests.current.delete(fileName)
      if (!result.ok) {
        if (result.error.kind !== 'cancelled') setLoadError({ key: detailKey, message: gitlabErrorMessage(result.error, t) })
        return null
      }
      setLoadError((error) => error?.key === detailKey ? null : error)
      setDetailEntries((entries) => ({ ...entries, [fileName]: { key: detailKey, value: result.value } }))
      vc.reconcileStaged(result.value)
      return result.value
    })
    detailRequests.current.set(fileName, { key: requestKey, operationId, promise })
    return promise
  }, [detailEntries, detailKeys, rootPath, t, vc])

  useEffect(() => {
    for (const [name, request] of detailRequests.current) {
      const expected = `${detailKeys[name]}:request`
      if (request.key !== expected) {
        void cancelGitlabOperation(request.operationId)
        detailRequests.current.delete(name)
      }
    }
  }, [detailKeys])

  useEffect(() => {
    const requests = detailRequests.current
    return () => {
      for (const request of requests.values()) void cancelGitlabOperation(request.operationId)
    }
  }, [rootPath])

  const loadingDetailNames = useMemo(() => new Set(detailFiles
    .filter((file) => detailLoading.has(`${detailKeys[file.name]}:request`))
    .map((file) => file.name)), [detailFiles, detailKeys, detailLoading])
  const stagedNames = Object.keys(vc.staged).sort().join('|')
  useEffect(() => {
    for (const name of Object.keys(vc.staged)) void loadDetail(name)
  }, [loadDetail, stagedNames, vc.staged])

  if (!vc.link) return null
  const localFiles = vc.files.filter((file) => ['localAdded', 'localModified', 'localDeleted'].includes(file.state))
  const upcomingFiles = vc.files.filter((file) => file.state === 'remoteChanged')
  const conflicts = vc.files.filter((file) => file.state === 'conflict')
  const stagedFiles = localFiles.filter((file) => vc.staged[file.name])
  const changedFiles = localFiles.filter((file) => {
    const selection = vc.staged[file.name]
    if (!selection) return true
    if (selection.wholeFile) return false
    const detail = details[file.name]
    return !detail || detail.items.some((item) => !selection.itemIds.includes(item.id))
  })
  const working = vc.busy !== null
  // A drive has nowhere to keep a commit message: OneDrive pushes without one.
  const needsMessage = vc.link.provider === 'gitlab'
  const canPush = vc.stagedSelections.length > 0 && conflicts.length === 0 && (!needsMessage || vc.message.trim() !== '') && !working
  const push = () => vc.push(needsMessage ? vc.message : ONEDRIVE_PUSH_MESSAGE, vc.stagedSelections)
  const toggleSection = (kind: CollapsibleSection) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    return next
  })
  const openReview = async (file: FileStatusDto, item: ChangedItemDto | null, direction: 'outgoing' | 'incoming') => {
    const detail = details[file.name] ?? await loadDetail(file.name)
    if (!detail) return
    if (onReview) onReview({ fileName: file.name, fileLabel: FILE_LABELS[file.name] ?? file.name, changes: detail, item, direction })
    else setInlineReview({ name: file.name, direction })
  }
  const toggleFile = (name: string) => {
    const opening = !expanded.has(name)
    setExpanded((current) => toggleSet(current, name))
    if (opening) void loadDetail(name)
  }
  const openConflict = async (file: FileStatusDto) => {
    const detail = details[file.name] ?? await loadDetail(file.name)
    if (detail) onResolveConflict(file.name, detail)
  }
  const stageItemWithDependencies = async (detail: StructuredFileChangesDto, itemId: string) => {
    const item = detail.items.find((candidate) => candidate.id === itemId)
    if (!item || item.dependencies.length === 0) {
      vc.stageItem(detail, itemId, details)
      return
    }
    const loaded = await Promise.all(localFiles.map((file) => loadDetail(file.name)))
    const completeDetails = { ...details }
    for (const candidate of loaded) if (candidate) completeDetails[candidate.name] = candidate
    vc.stageItem(detail, itemId, completeDetails)
  }

  return <div className="vc-linked">
    <div className="vc-repository">
      <div className="vc-repository-name">{vc.link.provider === 'gitlab' ? <GitIcon size={15} /> : <FolderIcon size={15} />}<span>{remoteLocation(vc.link)}</span></div>
      <div className="vc-repository-actions">
        <IconButton icon={vc.busy === 'pull' ? <Spinner size={13} /> : <GitPullIcon size={13} />} label={t('vc.action.pull')} disabled={working} onClick={onPull} />
        <IconButton icon={vc.checking ? <Spinner size={13} /> : <RefreshIcon size={13} />} label={t('vc.action.refresh')} disabled={working} onClick={() => void vc.refresh()} />
        <button className="vc-icon-button" type="button" aria-label={t('vc.action.more')} {...moreTooltip.triggerProps} onClick={() => setMenuOpen((value) => !value)}><EllipsisIcon /></button>{moreTooltip.tooltip}
        {menuOpen && <div className="vc-more-menu"><button type="button" onClick={() => void vc.unlink()}>{t('vc.action.unlink')}</button></div>}
      </div>
      {vc.link.provider === 'gitlab' && <div className="vc-branch"><BranchIcon size={13} />{vc.link.branch}</div>}
    </div>

    <div className="vc-linked-body">
      {needsMessage && <Input className="vc-commit-message" id="vc-commit-message" value={vc.message} aria-label={t('vc.commit.messageLabel')} placeholder={t('vc.commit.messagePlaceholder')} disabled={working} onChange={(event) => vc.setMessage(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canPush) void push() }} />}
      <Button className="vc-primary-action" isLoading={vc.busy === 'push'} disabled={!canPush} onClick={() => void push()}>{needsMessage ? t('vc.action.commitAndPush') : t('vc.action.push')}</Button>

      {vc.error && <InlineAlert>{gitlabErrorMessage(vc.error, t)}</InlineAlert>}
      {loadError && Object.values(detailKeys).includes(loadError.key) && <InlineAlert>{loadError.message}</InlineAlert>}
      {vc.notice && <p className="vc-notice" role="status">{vc.notice}</p>}

      {conflicts.length > 0 && <section className="vc-change-section vc-change-section--conflicts">
        <header className="vc-section-header"><button type="button" onClick={() => toggleSection('conflicts')} aria-expanded={!collapsed.has('conflicts')}>{collapsed.has('conflicts') ? <ChevronRightIcon /> : <ChevronDownIcon />}<h3>{t('vc.sections.conflicts')} <span>{conflicts.length}</span></h3></button></header>
        {!collapsed.has('conflicts') && conflicts.map((file) => <div className="vc-conflict-row" key={file.name}>
          <button type="button" className="vc-tree-label" onClick={() => void openReview(file, null, 'outgoing')}><span>{FILE_LABELS[file.name] ?? file.name}</span><small>{file.name}</small></button>
          <Button variant="ghost" disabled={working || loadingDetailNames.has(file.name)} onClick={() => void openConflict(file)}>{t('vc.resolve.open')}</Button>
        </div>)}
      </section>}

      <ChangeSection kind="upcoming" files={upcomingFiles} details={details} detailLoading={loadingDetailNames} expanded={expanded} collapsed={collapsed.has('upcoming')} vc={vc} onToggle={() => toggleSection('upcoming')} onToggleFile={toggleFile} onLoadDetail={loadDetail} onStageItem={stageItemWithDependencies} onReview={openReview} onPull={onPull} />
      <ChangeSection kind="staged" files={stagedFiles} details={details} detailLoading={loadingDetailNames} expanded={expanded} collapsed={collapsed.has('staged')} vc={vc} onToggle={() => toggleSection('staged')} onToggleFile={toggleFile} onLoadDetail={loadDetail} onStageItem={stageItemWithDependencies} onReview={openReview} />
      <ChangeSection kind="changes" files={changedFiles} details={details} detailLoading={loadingDetailNames} expanded={expanded} collapsed={collapsed.has('changes')} vc={vc} onToggle={() => toggleSection('changes')} onToggleFile={toggleFile} onLoadDetail={loadDetail} onStageItem={stageItemWithDependencies} onReview={openReview} />

      {vc.summary === 'clean' && !vc.checking && conflicts.length === 0 && upcomingFiles.length === 0 && localFiles.length === 0 && <p className="vc-clean-state">{t('vc.changes.empty')}</p>}
      {inlineReview && <DiffView rootPath={rootPath} fileName={inlineReview.name} version={vc.files} remoteRevision={vc.files.find((file) => file.name === inlineReview.name)?.remoteRevision} direction={inlineReview.direction} onClose={() => setInlineReview(null)} />}
    </div>
  </div>
}

interface ChangeSectionProps {
  kind: SectionKind
  files: FileStatusDto[]
  details: Record<string, StructuredFileChangesDto>
  detailLoading: Set<string>
  expanded: Set<string>
  collapsed: boolean
  vc: VersionControl
  onToggle: () => void
  onToggleFile: (name: string) => void
  onLoadDetail: (name: string) => Promise<StructuredFileChangesDto | null>
  onStageItem: (detail: StructuredFileChangesDto, itemId: string) => Promise<void>
  onReview: (file: FileStatusDto, item: ChangedItemDto | null, direction: 'outgoing' | 'incoming') => void
  onPull?: () => void
}

function ChangeSection({ kind, files, details, detailLoading, expanded, collapsed, vc, onToggle, onToggleFile, onLoadDetail, onStageItem, onReview, onPull }: ChangeSectionProps) {
  const { t } = useLanguage()
  const direction = kind === 'upcoming' ? 'incoming' : 'outgoing'
  return <section className={`vc-change-section vc-change-section--${kind}`}>
    <header className="vc-section-header">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed}>{collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}<h3>{t(`vc.sections.${kind}`)} <span>{files.length}</span></h3></button>
      {kind === 'upcoming' && files.length > 0 && <button type="button" className="vc-section-action" onClick={onPull}>{t('vc.upcoming.review')}</button>}
      {kind === 'staged' && files.length > 0 && <button type="button" className="vc-section-action" onClick={() => files.forEach((file) => vc.unstageFile(file.name, details))}>{t('vc.stage.unstageAll')}</button>}
      {kind === 'changes' && files.length > 0 && <button type="button" className="vc-section-action" onClick={() => void Promise.all(files.map((file) => onLoadDetail(file.name))).then((loaded) => loaded.forEach((detail) => detail && vc.stageFile(detail)))}>{t('vc.stage.stageAll')}</button>}
    </header>
    {!collapsed && (files.length === 0 ? <p className="vc-section-empty">{t(`vc.sections.${kind}Empty`)}</p> : <ul className="vc-change-tree" aria-label={t('vc.changes.listAria')}>
      {files.map((file) => <ChangeFile key={file.name} kind={kind} file={file} detail={details[file.name]} detailLoading={detailLoading.has(file.name)} allDetails={details} selection={vc.staged[file.name]} expanded={expanded.has(file.name)} vc={vc} onLoadDetail={onLoadDetail} onStageItem={onStageItem} onToggle={() => onToggleFile(file.name)} onReview={(item) => onReview(file, item, direction)} />)}
    </ul>)}
  </section>
}

function ChangeFile({ kind, file, detail, detailLoading, allDetails, selection, expanded, vc, onLoadDetail, onStageItem, onToggle, onReview }: {
  kind: SectionKind
  file: FileStatusDto
  detail?: StructuredFileChangesDto
  detailLoading: boolean
  allDetails: Record<string, StructuredFileChangesDto>
  selection?: VersionControl['staged'][string]
  expanded: boolean
  vc: VersionControl
  onLoadDetail: (name: string) => Promise<StructuredFileChangesDto | null>
  onStageItem: (detail: StructuredFileChangesDto, itemId: string) => Promise<void>
  onToggle: () => void
  onReview: (item: ChangedItemDto | null) => void
}) {
  const { t } = useLanguage()
  const pageKey = `${detail?.localRevision ?? ''}:${detail?.remoteRevision ?? ''}`
  const [page, setPage] = useState({ key: pageKey, count: DETAIL_PAGE_SIZE })
  const visibleCount = page.key === pageKey ? page.count : DETAIL_PAGE_SIZE
  const stagedIds = new Set(selection?.itemIds ?? [])
  const items = detail?.items.filter((item) => kind === 'upcoming' || (kind === 'staged' ? selection?.wholeFile || stagedIds.has(item.id) : !selection?.wholeFile && !stagedIds.has(item.id))) ?? []
  const visibleItems = items.slice(0, visibleCount)
  const canExpand = !detail || Boolean(detail.supportsPartial && items.length > 0)
  const action = kind === 'upcoming' ? null : kind === 'staged'
    ? <StageButton label={t('vc.stage.unstageFile', { file: file.name })} onClick={() => vc.unstageFile(file.name, allDetails)}>−</StageButton>
    : <StageButton label={t('vc.stage.stageFile', { file: file.name })} disabled={detailLoading} onClick={() => void onLoadDetail(file.name).then((loaded) => loaded && vc.stageFile(loaded))}>+</StageButton>
  const disclosureLabel = t(expanded ? 'vc.changes.collapseFile' : 'vc.changes.expandFile', { file: file.name })
  const disclosureTooltip = useTooltip(disclosureLabel)

  return <li className="vc-tree-file">
    <div className="vc-tree-file-row">
      <button type="button" className="vc-disclosure" aria-label={disclosureLabel} {...disclosureTooltip.triggerProps} disabled={!canExpand} onClick={onToggle}>{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}</button>{disclosureTooltip.tooltip}
      <button type="button" className="vc-tree-label" onClick={() => onReview(null)}><span>{FILE_LABELS[file.name] ?? file.name}</span><small className="vc-file-name">{file.name}</small></button>
      <span className="vc-file-badge" data-state={file.state}>{STATE_MARKERS[file.state]}</span>
      {action}
    </div>
    {expanded && detail && <ul className="vc-tree-items">{visibleItems.map((item) => <li key={item.id}>
      <button type="button" className="vc-tree-item-label" onClick={() => onReview(item)}><span className="vc-tree-item-icon">{entityIcon(item.itemKind)}</span><span className="vc-tree-item-copy"><span>{item.label}</span><small>{t(itemKindLabelKey(item.itemKind))} · {t(`vc.change.${item.changeKind}`)}</small>{item.dependencies.length > 0 && <em>{t('vc.stage.includesDependencies', { count: item.dependencies.length })}</em>}</span></button>
      {kind === 'staged' && <StageButton label={t('vc.stage.unstageItem', { item: item.label })} onClick={() => vc.unstageItem(detail, item.id, allDetails)}>−</StageButton>}
      {kind === 'changes' && <StageButton label={t('vc.stage.stageItem', { item: item.label })} onClick={() => void onStageItem(detail, item.id)}>+</StageButton>}
    </li>)}{items.length > visibleCount && <li><button type="button" className="vc-section-action" onClick={() => setPage({ key: pageKey, count: visibleCount + DETAIL_PAGE_SIZE })}>{t('vc.changes.loadMore')}</button></li>}</ul>}
  </li>
}

function StageButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: string }) {
  const { triggerProps, tooltip } = useTooltip(label)
  return <><button type="button" className="vc-stage-button" aria-label={label} {...triggerProps} disabled={disabled} onClick={onClick}>{children}</button>{tooltip}</>
}

function entityIcon(kind: string) {
  if (kind === 'flow') return <FlowIcon size={13} />
  if (kind === 'request') return <SendIcon size={13} />
  if (kind === 'environment') return <VariablesIcon size={13} />
  if (kind === 'monitor' && FEATURE_FLAGS.valueMonitors) return <MonitorIcon size={13} />
  return <FolderIcon size={13} />
}

function toggleSet(current: Set<string>, value: string) {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}
