import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { expandImportPaths } from '../../../bindings/expand-import-paths'
import { onFileDrop } from '../../../bindings/on-file-drop'
import { discardPreparedImport, type PreparedImportDto, type PrepareImportResult } from '../../../bindings/prepared-import'
import { pickImportFiles, pickImportFolder } from '../../../bindings/pick-import-file'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { Field } from '../../../shared/ui/Field'
import { ChevronDownIcon, ChevronRightIcon, ImportIcon, Spinner, TrashIcon } from '../../../shared/ui/icons'
import { IconButton } from '../../../shared/ui/IconButton'
import { InlineAlert } from '../../../shared/ui/InlineAlert'
import { Input } from '../../../shared/ui/Input'
import { LoadingBar } from '../../../shared/ui/LoadingBar'
import { Modal } from '../../../shared/ui/Modal'
import { Tabs } from '../../../shared/ui/Tabs'
import { Textarea } from '../../../shared/ui/Textarea'
import {
  importVariablesValid,
  initialImportVariables,
  type ExistingEnvironmentTarget,
  type ImportVariablesState,
} from '../import-variables'
import { ImportVariablesReview } from './ImportVariablesReview'
import './import-collection-modal.css'

type ImportTab = 'file' | 'url' | 'code'

export interface PreparedImportSelection {
  source: string
  summary: PreparedImportDto
  includeDocumentation: boolean
  /** Variable choices of the review (spec 0130). */
  variables: ImportVariablesState
}

interface ImportCollectionModalProps {
  onClose: () => void
  onPrepareFromPath: (path: string) => Promise<PrepareImportResult>
  onPrepareFromUrl: (url: string) => Promise<PrepareImportResult>
  onPrepareFromText: (content: string) => Promise<PrepareImportResult>
  onImportPrepared: (items: PreparedImportSelection[]) => void
  /** Workspace environments a variable can be merged into. */
  existingEnvironments: ExistingEnvironmentTarget[]
}

function selection(source: string, summary: PreparedImportDto): PreparedImportSelection {
  return { source, summary, includeDocumentation: summary.supportsDocumentation, variables: initialImportVariables(summary) }
}

function sourceName(path: string) {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
}

export function ImportCollectionModal({
  onClose,
  onPrepareFromPath,
  onPrepareFromUrl,
  onPrepareFromText,
  onImportPrepared,
  existingEnvironments,
}: ImportCollectionModalProps) {
  const { t } = useLanguage()
  const fieldId = useId()
  const transferred = useRef(false)
  const itemsRef = useRef<PreparedImportSelection[]>([])
  const [activeTab, setActiveTab] = useState<ImportTab>('file')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [items, setItems] = useState<PreparedImportSelection[]>([])
  const [expandedVariables, setExpandedVariables] = useState<ReadonlySet<string>>(() => new Set())
  const [reviewing, setReviewing] = useState(false)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const discardItems = useCallback((pending: PreparedImportSelection[]) => {
    for (const item of pending) void discardPreparedImport(item.summary.id)
  }, [])

  useEffect(
    () => () => {
      if (!transferred.current) discardItems(itemsRef.current)
    },
    [discardItems],
  )

  const replaceItems = useCallback(
    (next: PreparedImportSelection[]) => {
      discardItems(itemsRef.current)
      setItems(next)
      setReviewing(next.length > 0)
    },
    [discardItems],
  )

  const preparePaths = useCallback(
    async (paths: string[]) => {
      setLoading(true)
      setError(null)
      const expanded = await expandImportPaths(paths)
      if (!expanded.ok || expanded.value.length === 0) {
        setLoading(false)
        setError(expanded.ok ? t('collections.importFolderEmpty') : expanded.error.message)
        return
      }

      const prepared: PreparedImportSelection[] = []
      const failures: string[] = []
      for (const [index, path] of expanded.value.entries()) {
        setProgress({ current: index + 1, total: expanded.value.length })
        const result = await onPrepareFromPath(path)
        if (result.ok) {
          prepared.push(selection(sourceName(path), result.value))
        } else {
          failures.push(`${sourceName(path)}: ${result.error.message}`)
        }
      }
      setProgress(null)
      setLoading(false)
      replaceItems(prepared)
      if (failures.length > 0) setError(failures.join('\n'))
    },
    [onPrepareFromPath, replaceItems, t],
  )

  useEffect(() => {
    if (activeTab !== 'file' || reviewing) return
    let unlisten: (() => void) | undefined
    void onFileDrop((event) => {
      if (event.type === 'drop') {
        setDragOver(false)
        void preparePaths(event.paths)
      } else {
        setDragOver(event.type === 'enter' || event.type === 'over')
      }
    }).then((fn) => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [activeTab, preparePaths, reviewing])

  const prepareSingle = async (source: string, prepare: () => Promise<PrepareImportResult>) => {
    setLoading(true)
    setError(null)
    const result = await prepare()
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    replaceItems([selection(source, result.value)])
  }

  const updateDocumentation = (id: string, includeDocumentation: boolean) => {
    setItems((current) => current.map((item) => item.summary.id === id ? { ...item, includeDocumentation } : item))
  }

  const updateVariables = (id: string, variables: ImportVariablesState) => {
    setItems((current) => current.map((item) => item.summary.id === id ? { ...item, variables } : item))
  }

  const toggleVariables = (id: string) => {
    setExpandedVariables((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const variablesValid = items.every((item) => importVariablesValid(item.variables))

  const removeItem = (id: string) => {
    const item = items.find((candidate) => candidate.summary.id === id)
    if (item) void discardPreparedImport(item.summary.id)
    setItems((current) => current.filter((candidate) => candidate.summary.id !== id))
  }

  const changeTab = (tab: ImportTab) => {
    if (loading || tab === activeTab) return
    if (items.length > 0) {
      discardItems(items)
      setItems([])
    }
    setActiveTab(tab)
    setError(null)
  }

  return (
    <Modal title={t('collections.importModalTitle')} closeAriaLabel={t('collections.closeModalAria')} onClose={onClose} className={`ui-modal--form ui-modal--wide ui-modal--top import-modal${reviewing ? ' import-modal--review' : ''}`}>
      {!reviewing ? (
        <>
          <p className="ui-modal-description">{t('collections.importModalDescription')}</p>
          <Tabs<ImportTab>
            ariaLabel={t('collections.importModalTitle')}
            idPrefix={`${fieldId}-`}
            activeTab={activeTab}
            onChange={changeTab}
            tabs={[
              { id: 'file', label: t('collections.importFileTab'), disabled: loading },
              { id: 'url', label: t('collections.importUrlTab'), disabled: loading },
              { id: 'code', label: t('collections.importCodeTab'), disabled: loading },
            ]}
          />
          {loading && <LoadingBar />}
          <div id={`tabpanel-${fieldId}-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${fieldId}-${activeTab}`} className={activeTab === 'url' ? 'import-modal-panel import-modal-panel--compact' : 'import-modal-panel'}>
            {activeTab === 'file' && (
              <div className={dragOver ? 'import-modal-dropzone import-modal-dropzone--over' : 'import-modal-dropzone'}>
                {loading ? (
                  <p className="import-modal-dropzone-hint import-modal-dropzone-loading"><Spinner size={16} />{progress && progress.total > 1 ? t('collections.importReviewProgress', progress) : t('collections.importReviewing')}</p>
                ) : (
                  <div className="import-modal-dropzone-content">
                    <ImportIcon size={20} />
                    <p className="import-modal-dropzone-hint">
                      {t('collections.importDropHint')}{' '}
                      <button type="button" className="import-modal-choose-link" onClick={() => void pickImportFiles().then(preparePaths)}>{t('collections.importChooseFileLink')}</button>{' '}
                      {t('collections.importChooseFolderSeparator')}{' '}
                      <button type="button" className="import-modal-choose-link" onClick={() => void pickImportFolder().then((folder) => { if (folder) return preparePaths([folder]) })}>{t('collections.importChooseFolderLink')}</button>
                    </p>
                  </div>
                )}
              </div>
            )}
            {activeTab === 'url' && (
              <>
                <Field label={t('collections.importUrlLabel')} htmlFor={`${fieldId}-url`}><Input id={`${fieldId}-url`} mono value={url} placeholder={t('collections.importUrlPlaceholder')} onChange={(event) => setUrl(event.target.value)} /></Field>
                <div className="ui-modal-actions"><Button onClick={() => void prepareSingle(url, () => onPrepareFromUrl(url.trim()))} isLoading={loading} disabled={!url.trim() || loading}>{t('collections.importReviewAction')}</Button></div>
              </>
            )}
            {activeTab === 'code' && (
              <>
                <Field label={t('collections.importCodeLabel')} htmlFor={`${fieldId}-code`} className="import-modal-field--grow"><Textarea id={`${fieldId}-code`} mono className="import-modal-code-textarea" value={code} placeholder={t('collections.importCodePlaceholder')} onChange={(event) => setCode(event.target.value)} /></Field>
                <div className="ui-modal-actions"><Button onClick={() => void prepareSingle(t('collections.importCodeSource'), () => onPrepareFromText(code))} isLoading={loading} disabled={!code.trim() || loading}>{t('collections.importReviewAction')}</Button></div>
              </>
            )}
          </div>
          {items.length > 0 && !loading && (
            <div className="ui-modal-actions">
              <Button variant="ghost" onClick={() => setReviewing(true)}>{t('collections.importContinueReview')}</Button>
            </div>
          )}
        </>
      ) : (
        <div className="import-modal-review">
          <header className="import-modal-review-header">
            <h3 className="import-modal-review-title">{t('collections.importReviewTitle')}</h3>
            <p className="ui-modal-description">{t('collections.importReviewDescription')}</p>
          </header>
          <div className="import-modal-cards">
            {error && <InlineAlert className="import-modal-error">{error}</InlineAlert>}
            {items.map((item) => (
              <article className="import-modal-card" key={item.summary.id}>
                <header className="import-modal-card-header">
                  <ImportIcon size={16} />
                  <div className="import-modal-card-heading">
                    <strong title={item.summary.title || item.source}>{item.summary.title || item.source}</strong>
                    <div className="import-modal-card-meta">
                      <span className="import-modal-format">{item.summary.format}</span>
                      <span aria-hidden="true">·</span>
                      <span className="import-modal-card-source" title={item.source}>{item.source}</span>
                    </div>
                  </div>
                  <IconButton icon={<TrashIcon size={14} />} label={t('collections.importRemoveItem')} onClick={() => removeItem(item.summary.id)} />
                </header>
                <div className="import-modal-card-body">
                  <p className="import-modal-card-summary">{t('collections.importReviewCounts', { collections: item.summary.collectionCount, folders: item.summary.folderCount, requests: item.summary.requestCount })}</p>
                  {item.summary.warningCount > 0 && <p className="import-modal-card-summary">{t('collections.importReviewWarnings', { count: item.summary.warningCount })}</p>}
                  {item.summary.supportsDocumentation && (
                    <div className="import-modal-options" role="radiogroup" aria-label={t('collections.importContentLabel')}>
                      <label className={item.includeDocumentation ? 'import-modal-option import-modal-option--selected' : 'import-modal-option'}>
                        <input type="radio" name={`docs-${item.summary.id}`} checked={item.includeDocumentation} onChange={() => updateDocumentation(item.summary.id, true)} />
                        <span>{t('collections.importWithDocumentation')}</span>
                      </label>
                      <label className={!item.includeDocumentation ? 'import-modal-option import-modal-option--selected' : 'import-modal-option'}>
                        <input type="radio" name={`docs-${item.summary.id}`} checked={!item.includeDocumentation} onChange={() => updateDocumentation(item.summary.id, false)} />
                        <span>{t('collections.importCollectionOnly')}</span>
                      </label>
                    </div>
                  )}
                  {item.variables.rows.length > 0 && (
                    <div className="import-modal-variables">
                      <button type="button" className="import-modal-variables-toggle" aria-expanded={expandedVariables.has(item.summary.id)} onClick={() => toggleVariables(item.summary.id)}>
                        {expandedVariables.has(item.summary.id) ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                        <span>{t('collections.importVariablesToggle', { selected: item.variables.rows.filter((row) => row.include).length, total: item.variables.rows.length })}</span>
                        {!importVariablesValid(item.variables) && <span className="import-modal-variables-invalid">{t('collections.importVariablesNeedsAttention')}</span>}
                      </button>
                      {expandedVariables.has(item.summary.id) && (
                        <ImportVariablesReview
                          state={item.variables}
                          environmentNames={item.summary.environmentNames ?? []}
                          collectionNames={item.summary.collectionNames ?? []}
                          existingEnvironments={existingEnvironments}
                          onChange={(variables) => updateVariables(item.summary.id, variables)}
                        />
                      )}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="ui-modal-actions import-modal-review-actions">
            <Button variant="ghost" onClick={() => setReviewing(false)}>{t('common.back')}</Button>
            <Button disabled={items.length === 0 || !variablesValid} onClick={() => { transferred.current = true; onImportPrepared(items); onClose() }}>{t('collections.importAction')}</Button>
          </div>
        </div>
      )}
      {!reviewing && error && <InlineAlert className="import-modal-error">{error}</InlineAlert>}
    </Modal>
  )
}
