import { useState } from 'react'
import { itemKindLabelKey } from './file-labels'
import type { ChangedItemDto, StructuredFileChangesDto } from '../../bindings/version-control-types'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Tabs } from '../../shared/ui/Tabs'
import { DiffView } from './DiffView'

const DETAIL_PAGE_SIZE = 200

interface FileChangeViewerProps {
  rootPath: string
  fileName: string
  changes: StructuredFileChangesDto
  /** Quando informado, mostra só este item em vez de todos os itens alterados do arquivo. */
  item: ChangedItemDto | null
  direction?: 'outgoing' | 'incoming'
  /** A past commit: the "Code" tab compares the working copy, so it is left out. */
  historical?: boolean
}

/** Corpo com abas "Alterações" (diff semântico por item) e "Código" (diff bruto) de um arquivo. */
export function FileChangeViewer({ rootPath, fileName, changes, item, direction = 'outgoing', historical = false }: FileChangeViewerProps) {
  const { t } = useLanguage()
  const [mode, setMode] = useState<'changes' | 'code'>('changes')
  const pageKey = `${changes.localRevision ?? ''}:${changes.remoteRevision ?? ''}:${item?.id ?? ''}`
  const [page, setPage] = useState({ key: pageKey, count: DETAIL_PAGE_SIZE })
  const visibleCount = page.key === pageKey ? page.count : DETAIL_PAGE_SIZE
  const items = item ? [item] : changes.items
  const visibleItems = items.slice(0, visibleCount)

  return <>
    {!historical && <Tabs tabs={[{ id: 'changes', label: t('vc.review.changes') }, { id: 'code', label: t('vc.review.code') }]} activeTab={mode} onChange={(id) => setMode(id as 'changes' | 'code')} ariaLabel={t('vc.review.mode')} idPrefix="vc-review-" />}
    {mode === 'code' ? <div key={mode} id="tabpanel-vc-review-code" role="tabpanel" aria-labelledby="tab-vc-review-code" className="vc-review-code ui-tabpanel-motion"><DiffView rootPath={rootPath} fileName={fileName} version={changes.localRevision} remoteRevision={changes.remoteRevision} direction={direction} /></div> :
      <div key={mode} id="tabpanel-vc-review-changes" role="tabpanel" aria-labelledby="tab-vc-review-changes" className="vc-semantic-diff ui-tabpanel-motion">
        {items.length === 0 ? <p className="vc-muted">{t('vc.review.fileOnly')}</p> : visibleItems.map((changedItem) => <article key={changedItem.id} className="vc-semantic-item">
          <header><div><span className="vc-change-pill" data-kind={changedItem.changeKind}>{t(`vc.change.${changedItem.changeKind}`)}</span><h3>{changedItem.label}</h3></div><span>{t(itemKindLabelKey(changedItem.itemKind))}</span></header>
          {changedItem.dependencies.length > 0 && <p className="vc-dependencies">{t('vc.review.dependencies', { count: changedItem.dependencies.length })}</p>}
          {changedItem.fields.length === 0 ? <p className="vc-muted">{t('vc.review.structureChanged')}</p> : <div className="vc-field-list">{changedItem.fields.map((field) => <div className="vc-field-change" key={field.name}>
            <div className="vc-field-name">{field.name}</div>
            <pre className="vc-field-old">{(direction === 'incoming' ? field.local : field.remote) ?? t('vc.review.absent')}</pre>
            <pre className="vc-field-new">{(direction === 'incoming' ? field.remote : field.local) ?? t('vc.review.absent')}</pre>
          </div>)}</div>}
        </article>)}
        {items.length > visibleCount && <Button variant="ghost" onClick={() => setPage({ key: pageKey, count: visibleCount + DETAIL_PAGE_SIZE })}>{t('vc.changes.loadMore')}</Button>}
      </div>}
  </>
}
