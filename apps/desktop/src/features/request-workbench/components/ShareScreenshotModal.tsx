import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AuthenticationInput } from '../../../bindings/execute-graphql-request'
import { exportPng } from '../../../bindings/export-png'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { pickExportFile } from '../../../bindings/pick-export-file'
import { serializeCollections } from '../../../bindings/serialize-collections'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { CopyIcon, DownloadIcon } from '../../../shared/ui/icons'
import { Modal } from '../../../shared/ui/Modal'
import { SegmentedControl } from '../../../shared/ui/SegmentedControl'
import { useToast } from '../../../shared/ui/use-toast'
import type { SnippetTab } from '../code-snippets/snippet-request'
import type { ExecutionState } from '../request-workbench.types'
import { describeError } from '../response-summary'
import {
  IMPORT_PNG_KEYWORD,
  buildImportCollection,
  clearSuspectedPasswordsForImport,
  hasSuspectedPasswordInImportMetadata,
} from '../screenshot/import-metadata'
import { embedPngText } from '../screenshot/png-text-chunk'
import { buildScreenshotContent, isScreenshotEmpty, type ScreenshotContentText } from '../screenshot/screenshot-content'
import { layoutScreenshot, type ScreenshotLayoutLabels } from '../screenshot/screenshot-layout'
import {
  RESPONSE_FIELDS,
  SCREENSHOT_FIELDS,
  loadScreenshotOptions,
  persistScreenshotOptions,
  type ScreenshotField,
  type ScreenshotLineLimit,
  type ScreenshotOptions,
} from '../screenshot/screenshot-options'
import { SCREENSHOT_PALETTES } from '../screenshot/screenshot-palette'
import { canvasToPng, createMeasure, drawScreenshot, ensureScreenshotFonts } from '../screenshot/screenshot-render'
import { OptionSelect, type SelectOption } from './OptionSelect'
import './share-screenshot-modal.css'

interface ShareScreenshotModalProps {
  tab: SnippetTab
  execution: ExecutionState
  /** Autenticação efetiva da coleção/pasta, usada quando a aba herda (`inherit`). */
  inheritedAuthentication: AuthenticationInput | undefined
  environmentVariables: EnvironmentVariableDto[]
  requestName: string
  environmentName: string | null
  onClose: () => void
}

const pad = (value: number) => String(value).padStart(2, '0')

/** `Minha requisição-20260926-1432`: o nome identifica, a data diferencia capturas da mesma requisição. */
function suggestedFileName(requestName: string, date: Date): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  return `${requestName}-${stamp}`
}

/** Falha ao gerar os dados de importação — a imagem em si está pronta. */
class ImportMetadataError extends Error {}

function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="share-shot-group">
      <span className="share-shot-group-label">{label}</span>
      {children}
    </div>
  )
}

/**
 * Compartilhar a requisição como imagem: um PNG organizado de URL,
 * requisição e resposta para anexar como evidência. A prévia é o próprio
 * canvas exportado, então o que aparece é o que é copiado ou salvo.
 */
export function ShareScreenshotModal({
  tab,
  execution,
  inheritedAuthentication,
  environmentVariables,
  requestName,
  environmentName,
  onClose,
}: ShareScreenshotModalProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const lineLimitId = useId()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [options, setOptions] = useState<ScreenshotOptions>(loadScreenshotOptions)
  const [capturedAt] = useState(() => new Date())
  const [fontsReady, setFontsReady] = useState(false)
  const [renderFailed, setRenderFailed] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null)
  const [pendingExport, setPendingExport] = useState<'copy' | 'save' | null>(null)
  const hasResponse = execution.status === 'success' || execution.status === 'error'

  useEffect(() => {
    persistScreenshotOptions(options)
  }, [options])

  useEffect(() => {
    let cancelled = false
    void ensureScreenshotFonts().then(() => {
      if (!cancelled) setFontsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const text = useMemo<ScreenshotContentText>(
    () => ({
      capturedAt: new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(capturedAt),
      errorMessage: (error) => describeError(t, error),
      binaryBody: (size) => t('share.image.binaryBody', { size }),
      emptyBody: t('share.image.emptyBody'),
      previewOnly: (shown, total) => t('share.image.previewOnly', { shown, total }),
      file: (path) => t('share.image.file', { path }),
    }),
    [t, language, capturedAt],
  )

  const labels = useMemo<ScreenshotLayoutLabels>(
    () => ({
      request: t('share.image.request'),
      response: t('share.image.response'),
      headers: 'Headers',
      body: 'Body',
      environment: (name) => t('share.image.environment', { name }),
      capturedAt: (date) => t('share.image.capturedAt', { date }),
      moreLines: (count) => (count === 1 ? t('share.image.moreLine') : t('share.image.moreLines', { count })),
      truncated: t('share.image.truncated'),
    }),
    [t],
  )

  const content = useMemo(
    () =>
      buildScreenshotContent(
        { tab, execution, inheritedAuthentication, environmentVariables, requestName, environmentName },
        options,
        text,
      ),
    [tab, execution, inheritedAuthentication, environmentVariables, requestName, environmentName, options, text],
  )
  const empty = isScreenshotEmpty(content)

  const importCollection = useMemo(
    () =>
      options.includeImportMetadata
        ? buildImportCollection({
            tab,
            inheritedAuthentication,
            requestName,
            hideSensitive: options.hideSensitive,
          })
        : null,
    [options.includeImportMetadata, options.hideSensitive, tab, inheritedAuthentication, requestName],
  )
  const hasSuspectedPassword = useMemo(
    () => hasSuspectedPasswordInImportMetadata({ tab, inheritedAuthentication, environmentVariables }),
    [tab, inheritedAuthentication, environmentVariables],
  )

  /** PNG final: o canvas, mais a requisição embutida quando a opção está marcada. */
  const renderPng = async (canvas: HTMLCanvasElement, clearSuspectedPasswords = false): Promise<Blob> => {
    const blob = await canvasToPng(canvas)
    if (!importCollection) return blob
    const collection = clearSuspectedPasswords
      ? (() => {
          const cleared = clearSuspectedPasswordsForImport({ tab, inheritedAuthentication, environmentVariables })
          return buildImportCollection({
            tab: cleared.tab,
            inheritedAuthentication: cleared.inheritedAuthentication,
            requestName,
            hideSensitive: options.hideSensitive,
          })
        })()
      : importCollection
    const serialized = await serializeCollections([collection])
    if (!serialized.ok) throw new ImportMetadataError(serialized.error.message)
    const bytes = embedPngText(new Uint8Array(await blob.arrayBuffer()), IMPORT_PNG_KEYWORD, serialized.value)
    return new Blob([bytes], { type: 'image/png' })
  }

  const showFailure = (error: unknown, fallback: string) => {
    if (error instanceof ImportMetadataError) showToast(t('share.image.metadataError', { message: error.message }), 'error')
    else showToast(fallback, 'error')
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!fontsReady || empty || !canvas) return
    // Um desenho por quadro: vários cliques seguidos nas opções não enfileiram desenhos.
    const frame = window.requestAnimationFrame(() => {
      try {
        const layout = layoutScreenshot(content, options, createMeasure(canvas.getContext('2d')), labels)
        setRenderFailed(!drawScreenshot(canvas, layout, SCREENSHOT_PALETTES[options.theme]))
        setTruncated(layout.truncated)
      } catch {
        setRenderFailed(true)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fontsReady, empty, content, options, labels])

  const update = (patch: Partial<ScreenshotOptions>) => setOptions((current) => ({ ...current, ...patch }))
  const toggleField = (field: ScreenshotField) =>
    setOptions((current) => ({ ...current, fields: { ...current.fields, [field]: !current.fields[field] } }))

  const handleCopy = async (clearSuspectedPasswords = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    setBusy('copy')
    try {
      // A Promise do blob entra direto no ClipboardItem: o WebKit exige que a escrita comece no gesto do usuário.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderPng(canvas, clearSuspectedPasswords) })])
      showToast(t('share.image.copySuccess'))
    } catch (error) {
      showFailure(error, t('share.image.copyError'))
    } finally {
      setBusy(null)
    }
  }

  const handleSave = async (clearSuspectedPasswords = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const path = await pickExportFile(suggestedFileName(requestName, capturedAt), 'png')
    if (!path) return
    setBusy('save')
    try {
      const blob = await renderPng(canvas, clearSuspectedPasswords)
      const result = await exportPng(path, new Uint8Array(await blob.arrayBuffer()))
      if (result.ok) showToast(t('share.image.saveSuccess'))
      else showToast(t('share.image.saveError', { message: result.error.message }), 'error')
    } catch (error) {
      showFailure(error, t('share.image.renderError'))
    } finally {
      setBusy(null)
    }
  }

  const lineLimitOptions: SelectOption<ScreenshotLineLimit>[] = [
    { value: '30', label: '30' },
    { value: '60', label: '60' },
    { value: '120', label: '120' },
    { value: 'all', label: t('share.image.lineLimit.all') },
  ]
  const actionsDisabled = empty || renderFailed || !fontsReady || busy !== null
  const requestExport = (kind: 'copy' | 'save') => {
    if (options.includeImportMetadata && hasSuspectedPassword) {
      setPendingExport(kind)
      return
    }
    if (kind === 'copy') void handleCopy()
    else void handleSave()
  }
  const continueExport = (clearSuspectedPasswords: boolean) => {
    const kind = pendingExport
    setPendingExport(null)
    if (kind === 'copy') void handleCopy(clearSuspectedPasswords)
    if (kind === 'save') void handleSave(clearSuspectedPasswords)
  }

  return (
    <Modal
      title={t('share.image.title')}
      closeAriaLabel={t('collections.closeModalAria')}
      onClose={onClose}
      className="share-shot-modal"
    >
      <div className="share-shot">
        <div className="share-shot-options">
          <OptionGroup label={t('share.image.layout')}>
            <SegmentedControl
              layout="inline"
              className="share-shot-segmented"
              ariaLabel={t('share.image.layout')}
              value={options.layout}
              onChange={(layout) => update({ layout })}
              options={[
                { value: 'vertical', label: t('share.image.layout.vertical') },
                { value: 'sideBySide', label: t('share.image.layout.sideBySide') },
              ]}
            />
          </OptionGroup>
          <OptionGroup label={t('share.image.theme')}>
            <SegmentedControl
              layout="inline"
              className="share-shot-segmented"
              ariaLabel={t('share.image.theme')}
              value={options.theme}
              onChange={(theme) => update({ theme })}
              options={[
                { value: 'light', label: t('share.image.theme.light') },
                { value: 'dark', label: t('share.image.theme.dark') },
              ]}
            />
          </OptionGroup>
          <OptionGroup label={t('share.image.width')}>
            <SegmentedControl
              layout="inline"
              className="share-shot-segmented"
              ariaLabel={t('share.image.width')}
              value={options.width}
              onChange={(width) => update({ width })}
              options={[
                { value: 'compact', label: t('share.image.width.compact') },
                { value: 'standard', label: t('share.image.width.standard') },
                { value: 'wide', label: t('share.image.width.wide') },
              ]}
            />
          </OptionGroup>
          <fieldset className="share-shot-group share-shot-fields">
            <legend className="share-shot-group-label">{t('share.image.fields')}</legend>
            {SCREENSHOT_FIELDS.map((field) => (
              <label key={field} className="share-shot-check">
                <Checkbox
                  checked={options.fields[field]}
                  disabled={RESPONSE_FIELDS.has(field) && !hasResponse}
                  onChange={() => toggleField(field)}
                />
                <span>{t(`share.image.field.${field}`)}</span>
              </label>
            ))}
            {!hasResponse && <p className="share-shot-hint">{t('share.image.noResponse')}</p>}
          </fieldset>
          <div className="share-shot-group">
            <label className="share-shot-group-label" htmlFor={lineLimitId}>
              {t('share.image.lineLimit')}
            </label>
            <OptionSelect
              id={lineLimitId}
              value={options.lineLimit}
              options={lineLimitOptions}
              onChange={(lineLimit) => update({ lineLimit })}
            />
          </div>
          <div className="share-shot-group">
            <label className="share-shot-check">
              <Checkbox checked={options.hideSensitive} onChange={() => update({ hideSensitive: !options.hideSensitive })} />
              <span>{t('share.image.hideSensitive')}</span>
            </label>
          </div>
          <div className="share-shot-group">
            <label className="share-shot-check">
              <Checkbox
                checked={options.includeImportMetadata}
                onChange={() => update({ includeImportMetadata: !options.includeImportMetadata })}
              />
              <span>{t('share.image.importMetadata')}</span>
            </label>
          </div>
        </div>

        <div className="share-shot-preview">
          {empty ? (
            <p className="share-shot-empty">{t('share.image.empty')}</p>
          ) : (
            <>
              {renderFailed && <p className="share-shot-empty">{t('share.image.renderError')}</p>}
              <canvas
                ref={canvasRef}
                hidden={renderFailed}
                className="share-shot-canvas"
                role="img"
                aria-label={t('share.image.previewLabel')}
              />
            </>
          )}
          {!empty && truncated && <p className="share-shot-hint">{t('share.image.truncated')}</p>}
        </div>
      </div>

      <div className="ui-modal-actions">
        <Button variant="ghost" size="md" isLoading={busy === 'copy'} disabled={actionsDisabled} onClick={() => requestExport('copy')}>
          {busy !== 'copy' && <CopyIcon size={14} />}
          {t('share.image.copy')}
        </Button>
        <Button variant="primary" size="md" isLoading={busy === 'save'} disabled={actionsDisabled} onClick={() => requestExport('save')}>
          {busy !== 'save' && <DownloadIcon size={14} />}
          {t('share.image.save')}
        </Button>
      </div>
      {pendingExport && (
        <Modal
          title={t('share.image.passwordDialog.title')}
          closeAriaLabel={t('collections.closeModalAria')}
          onClose={() => setPendingExport(null)}
          className="ui-modal--form"
        >
          <p className="ui-modal-description">{t('share.image.passwordDialog.description')}</p>
          <div className="ui-modal-actions">
            <Button variant="ghost" onClick={() => continueExport(false)}>
              {t('share.image.passwordDialog.exportAsIs')}
            </Button>
            <Button variant="primary" autoFocus onClick={() => continueExport(true)}>
              {t('share.image.passwordDialog.clearAndExport')}
            </Button>
          </div>
        </Modal>
      )}
    </Modal>
  )
}
