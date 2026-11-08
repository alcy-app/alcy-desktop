import { useEffect, useMemo, useState } from 'react'
import { cancelVersionControlOperation } from '../../bindings/cancel-version-control-operation'
import type { ChangedItemDto, ResolutionPreviewDto, StructuredFileChangesDto } from '../../bindings/version-control-types'
import { previewConflictResolution } from '../../bindings/preview-conflict-resolution'
import { versionControlErrorMessage } from '../../shared/version-control-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { EyeIcon, EyeOffIcon, Spinner } from '../../shared/ui/icons'
import { useTooltip } from '../../shared/ui/use-tooltip'
import { DiffView } from './DiffView'
import { FILE_LABELS } from './file-labels'
import type { VersionControl } from './use-version-control'

export interface ConflictResolutionTarget {
  fileName: string
  changes: StructuredFileChangesDto
}

interface ConflictResolverProps {
  rootPath: string
  vc: VersionControl
  target: ConflictResolutionTarget
  onResolved: () => void
}

type Side = 'local' | 'remote'
type PreviewState = { status: 'idle' | 'loading' } | { status: 'ready'; value: ResolutionPreviewDto } | { status: 'error'; message: string; stale: boolean }

export function ConflictResolver({ rootPath, vc, target, onResolved }: ConflictResolverProps) {
  const { t } = useLanguage()
  const items = target.changes.items
  const structured = target.changes.supportsPartial && items.length > 0
  const [choices, setChoices] = useState<Record<string, Side>>({})
  const [activeId, setActiveId] = useState(items[0]?.id ?? '*')
  const [pendingOnly, setPendingOnly] = useState(false)
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const total = structured ? items.length : 1
  const done = structured ? Object.keys(choices).filter((id) => id !== '*').length : Number(Boolean(choices['*']))
  const complete = done === total
  const working = vc.busy !== null
  const activeItem = items.find((item) => item.id === activeId) ?? items[0]
  const visibleItems = useMemo(() => pendingOnly ? items.filter((item) => !choices[item.id]) : items, [choices, items, pendingOnly])

  useEffect(() => {
    if (!structured || !complete || !activeItem) {
      return
    }
    let cancelled = false
    const operationId = crypto.randomUUID()
    void Promise.resolve().then(() => {
      if (!cancelled) setPreview({ status: 'loading' })
    })
    const resolutions = items.map((item) => ({ itemId: item.id, side: choices[item.id] }))
    void previewConflictResolution(rootPath, operationId, target.fileName, resolutions, target.changes.localRevision, target.changes.remoteRevision, activeItem.id).then((result) => {
      if (cancelled) return
      if (result.ok) setPreview({ status: 'ready', value: result.value })
      else setPreview({ status: 'error', message: result.error.kind === 'conflict' ? t('vc.resolve.stale') : versionControlErrorMessage(result.error, t), stale: result.error.kind === 'conflict' })
    })
    return () => {
      cancelled = true
      void cancelVersionControlOperation(operationId)
    }
  }, [activeItem, choices, complete, items, rootPath, structured, t, target.changes.localRevision, target.changes.remoteRevision, target.fileName])

  const choose = (id: string, side: Side) => {
    setPreview({ status: 'idle' })
    setChoices((current) => ({ ...current, [id]: side }))
    setSubmitError(null)
  }
  const chooseAll = (side: Side) => {
    setPreview({ status: 'idle' })
    setChoices(structured ? Object.fromEntries(items.map((item) => [item.id, side])) : { '*': side })
    setSubmitError(null)
  }
  const move = (step: number) => {
    if (!activeItem || items.length === 0) return
    const index = items.findIndex((item) => item.id === activeItem.id)
    setActiveId(items[(index + step + items.length) % items.length].id)
  }
  const submit = async () => {
    setSubmitError(null)
    const resolution = structured ? {
      kind: 'perItem' as const,
      items: items.map((item) => ({ itemId: item.id, side: choices[item.id] })),
      expectedLocalRevision: target.changes.localRevision,
      expectedRemoteRevision: target.changes.remoteRevision,
    } : choices['*'] === 'local' ? { kind: 'keepLocal' as const } : { kind: 'keepRemote' as const }
    const result = await vc.resolve(target.fileName, resolution)
    if (result.ok) onResolved()
    else setSubmitError(result.error.kind === 'conflict' ? t('vc.resolve.stale') : versionControlErrorMessage(result.error, t))
  }

  return <section className="vc-review vc-conflict-resolver" aria-label={t('vc.resolve.title')}>
    <header className="vc-review-header vc-resolver-header">
      <div><span className="vc-review-eyebrow">{t('vc.resolve.title')}</span><h2>{FILE_LABELS[target.fileName] ?? target.fileName}</h2><p>{target.fileName}</p></div>
      <div className="vc-resolve-bulk"><Button variant="ghost" disabled={working} onClick={() => chooseAll('local')}>{t('vc.resolve.keepAllMine')}</Button><Button variant="ghost" disabled={working} onClick={() => chooseAll('remote')}>{t('vc.resolve.keepAllTheirs')}</Button></div>
    </header>

    {structured ? <div className="vc-resolver-body">
      <aside className="vc-resolver-nav" aria-label={t('vc.resolve.itemsAria')}>
        <label className="vc-pending-filter"><input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />{t('vc.resolve.pendingOnly')}</label>
        <div className="vc-resolver-items" role="listbox">
          {visibleItems.map((item) => <button key={item.id} type="button" role="option" aria-selected={activeItem?.id === item.id} onClick={() => setActiveId(item.id)}>
            <span>{item.label}</span><small data-side={choices[item.id] ?? 'pending'}>{t(`vc.resolve.state.${choices[item.id] ?? 'pending'}`)}</small>
          </button>)}
          {visibleItems.length === 0 && <p className="vc-section-empty">{t('vc.resolve.noPending')}</p>}
        </div>
      </aside>
      <main className="vc-resolver-detail">
        {activeItem && <>
          <div className="vc-resolver-entity-header"><div><span className="vc-change-pill" data-kind={activeItem.changeKind}>{t(`vc.change.${activeItem.changeKind}`)}</span><h3>{activeItem.label}</h3></div><div className="vc-resolver-nav-buttons"><Button variant="ghost" onClick={() => move(-1)}>{t('vc.resolve.previous')}</Button><Button variant="ghost" onClick={() => move(1)}>{t('vc.resolve.next')}</Button></div></div>
          <div className="vc-compare-grid">
            <ChoicePane title={t('vc.resolve.mine')} side="local" item={activeItem} selected={choices[activeItem.id] === 'local'} onChoose={() => choose(activeItem.id, 'local')} />
            <ChoicePane title={t('vc.resolve.theirs')} side="remote" item={activeItem} selected={choices[activeItem.id] === 'remote'} onChoose={() => choose(activeItem.id, 'remote')} />
          </div>
          <section className="vc-resolution-result">
            <h3>{t('vc.resolve.result')}</h3>
            {!complete && <p className="vc-muted">{t('vc.resolve.resultPending')}</p>}
            {complete && preview.status === 'loading' && <p className="vc-muted" role="status"><Spinner size={14} /> {t('vc.resolve.previewLoading')}</p>}
            {complete && preview.status === 'ready' && <PreviewFields preview={preview.value} />}
            {complete && preview.status === 'error' && <InlineAlert>{preview.message}{preview.stale && <Button variant="ghost" onClick={() => { void vc.refresh(); onResolved() }}>{t('vc.resolve.reload')}</Button>}</InlineAlert>}
          </section>
        </>}
      </main>
    </div> : <div className="vc-whole-file-resolver">
      <p className="vc-muted">{t('vc.resolve.wholeFileOnly')}</p>
      <div className="vc-whole-file-choices" role="group" aria-label={t('vc.resolve.chooseFile')}>
        <button type="button" aria-pressed={choices['*'] === 'local'} onClick={() => choose('*', 'local')}>{t('vc.resolve.mine')}</button>
        <button type="button" aria-pressed={choices['*'] === 'remote'} onClick={() => choose('*', 'remote')}>{t('vc.resolve.theirs')}</button>
      </div>
      <DiffView rootPath={rootPath} fileName={target.fileName} version={target.changes.localRevision} remoteRevision={target.changes.remoteRevision} />
      {choices['*'] && <section className="vc-resolution-result"><h3>{t('vc.resolve.result')}</h3><p>{t(choices['*'] === 'local' ? 'vc.resolve.resultLocalFile' : 'vc.resolve.resultRemoteFile')}</p></section>}
    </div>}

    {submitError && <InlineAlert>{submitError}</InlineAlert>}
    <footer className="vc-resolver-footer"><span>{t('vc.resolve.progress', { done, total })}</span><Button isLoading={vc.busy === 'resolve'} disabled={!complete || working || (structured && preview.status !== 'ready')} onClick={() => void submit()}>{t('vc.resolve.submit')}</Button></footer>
  </section>
}

function ChoicePane({ title, side, item, selected, onChoose }: { title: string; side: Side; item: ChangedItemDto; selected: boolean; onChoose: () => void }) {
  const { t } = useLanguage()
  return <section className="vc-choice-pane" data-selected={selected}>
    <header><h4>{title}</h4><Button variant="ghost" aria-label={title} aria-pressed={selected} onClick={onChoose}>{t('vc.resolve.useVersion')}</Button></header>
    <div className="vc-choice-fields">{item.fields.length === 0 ? <p className="vc-muted">{t('vc.review.structureChanged')}</p> : item.fields.map((field) => <SemanticField key={field.name} name={field.name} value={field[side]} />)}</div>
  </section>
}

function PreviewFields({ preview }: { preview: ResolutionPreviewDto }) {
  const { t } = useLanguage()
  if (!preview.exists) return <p className="vc-muted">{t('vc.resolve.resultDeleted')}</p>
  return <div className="vc-result-fields">{preview.fields.map((field) => <SemanticField key={field.name} name={field.name} value={field.value} />)}</div>
}

function SemanticField({ name, value }: { name: string; value: string | null }) {
  const { t } = useLanguage()
  if (value === null) return <div className="vc-semantic-field"><strong>{name}</strong><span>{t('vc.review.absent')}</span></div>
  const parsed = parseJson(value)
  if (Array.isArray(parsed) && parsed.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
    const keys = [...new Set(parsed.flatMap((entry) => Object.keys(entry as Record<string, unknown>)))].filter((key) => key !== 'id')
    return <div className="vc-semantic-field"><strong>{name}</strong><div className="vc-value-table-wrap"><table className="vc-value-table"><thead><tr>{keys.map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{parsed.map((entry, index) => <tr key={index}>{keys.map((key) => <td key={key}><TableCellValue entry={entry as Record<string, unknown>} field={key} /></td>)}</tr>)}</tbody></table></div></div>
  }
  const isCode = ['query', 'document', 'body', 'script'].some((part) => name.toLowerCase().includes(part)) || typeof parsed === 'object'
  return <div className="vc-semantic-field"><strong>{name}</strong>{isCode ? <pre>{typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : value}</pre> : <span>{value}</span>}</div>
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return value }
}

function TableCellValue({ entry, field }: { entry: Record<string, unknown>; field: string }) {
  const { t } = useLanguage()
  const [revealed, setRevealed] = useState(false)
  const sensitive = entry.sensitive === true && field === 'value'
  const secretHeader = field === 'value' && typeof entry.name === 'string' && /authorization|token|api[-_ ]?key|secret/i.test(entry.name)
  const value = formatCellValue(entry[field])
  const action = revealed ? t('environments.hide') : t('environments.reveal')
  const { triggerProps, tooltip } = useTooltip(action)
  if (!sensitive && !secretHeader) return value
  return <span className="vc-sensitive-value"><span>{revealed ? value : '••••••••'}</span><button type="button" aria-label={action} {...triggerProps} onClick={() => setRevealed((current) => !current)}>{revealed ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}</button>{tooltip}</span>
}

function formatCellValue(value: unknown) {
  return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
}
