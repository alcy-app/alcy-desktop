import { useCallback, useEffect, useRef, useState } from 'react'
import { exportFlow, flowExportError, previewFlowExport, type FlowExportPreview, type FlowExportSource } from '../../bindings/export-flow'
import { pickExportFile } from '../../bindings/pick-export-file'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Modal } from '../../shared/ui/Modal'
import './flow-export.css'

export function ExportFlowModal({ source, onClose }: { source: FlowExportSource; onClose: () => void }) {
  const { t } = useLanguage()
  const [preview, setPreview] = useState<FlowExportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const active = useRef(false)
  const writing = useRef(false)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  const write = useCallback(async (inline: boolean) => {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    setError(null)
    try {
      const path = await pickExportFile(source.flow.name, 'flow')
      if (!active.current) return
      if (path) await exportFlow(source, path, inline)
      if (active.current) closeRef.current()
    } catch (cause) {
      if (active.current) setError(flowExportError(cause) ?? t('flows.export.error'))
    } finally {
      writing.current = false
      if (active.current) setBusy(false)
    }
  }, [source, t])

  useEffect(() => {
    active.current = true
    let cancelled = false
    void previewFlowExport(source).then(async (result) => {
      if (cancelled) return
      setPreview(result)
      if (!result.hasDependencies) await write(false)
      else setBusy(false)
    }).catch((cause: unknown) => {
      if (cancelled) return
      setError(flowExportError(cause) ?? t('flows.export.error'))
      setBusy(false)
    })
    return () => { cancelled = true; active.current = false }
  }, [source, t, write])

  return <Modal title={t('flows.export.title')} closeAriaLabel={t('collections.closeModalAria')} onClose={onClose} className="ui-modal--form ui-modal--md">
    {preview?.hasDependencies && <>
      <p className="ui-modal-description">{t('flows.export.description', { requests: preview.requestCount, variables: preview.variableCount })}</p>
      <p className="ui-modal-description">{t('flows.export.originalUnchanged')}</p>
      {preview.emptyVariableCount > 0 && <p className="ui-modal-description">{t('flows.export.emptyValues', { count: preview.emptyVariableCount })}</p>}
      {!preview.canInline && <p className="ui-modal-description">{t('flows.export.unsupported')}</p>}
    </>}
    {busy && <p role="status">{t('flows.export.working')}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="ui-modal-actions flow-export-actions">
      <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
      {preview && <Button variant="ghost" disabled={busy} onClick={() => { void write(false) }}>{t('flows.export.asIs')}</Button>}
      {preview?.hasDependencies && <Button variant="primary" disabled={busy || !preview.canInline} onClick={() => { void write(true) }}>{t('flows.export.inline')}</Button>}
    </div>
  </Modal>
}
