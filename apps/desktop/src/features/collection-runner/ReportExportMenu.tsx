import { useState } from 'react'
import type { FocusEvent } from 'react'
import { exportCollectionRunReport } from '../../bindings/export-collection-run-report'
import type { RunReportFormat } from '../../bindings/export-collection-run-report'
import { pickReportFile } from '../../bindings/pick-report-file'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { MenuItem } from '../../shared/ui/Menu'
import { DownloadIcon } from '../../shared/ui/icons'
import { useToast } from '../../shared/ui/use-toast'

interface ReportExportMenuProps {
  rootPath: string
  runId: string
  /** Base do nome de arquivo sugerido. */
  fileName: string
}

const FORMATS: RunReportFormat[] = ['html', 'json', 'junit']

/** "Exportar" com os formatos de relatório do run (spec 0074). */
export function ReportExportMenu({ rootPath, runId, fileName }: ReportExportMenuProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const exportAs = async (format: RunReportFormat) => {
    setOpen(false)
    const path = await pickReportFile(fileName, format)
    if (!path) return
    setBusy(true)
    const result = await exportCollectionRunReport({ rootPath, runId, path, format, language })
    setBusy(false)
    if (result.ok) showToast(t('runner.report.exported'))
    else
      showToast(
        result.error.kind === 'notFound'
          ? t('runner.report.notFound')
          : t('runner.report.failed', { message: result.error.message }),
        'error',
      )
  }

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }

  return (
    <div className="ui-menu-host" onBlur={closeOnBlur}>
      <Button
        variant="ghost"
        className="runner-action"
        aria-haspopup="true"
        aria-expanded={open}
        isLoading={busy}
        onClick={() => setOpen((current) => !current)}
      >
        {!busy && <DownloadIcon size={12} />}
        {t('runner.report.export')}
      </Button>
      {open && (
        <div
          className="ui-menu runner-export-menu"
          role="menu"
          aria-label={t('runner.report.export')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
          }}
        >
          {FORMATS.map((format, index) => (
            <MenuItem
              key={format}
              autoFocus={index === 0}
              label={t(`runner.report.format.${format}`)}
              onSelect={() => void exportAs(format)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
