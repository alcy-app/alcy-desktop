import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { RawBodyLanguage } from '../../../bindings/execute-rest-request'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { checkBodyFiles, type BodyFileStatus } from '../../../bindings/check-body-files'
import type { CommandResult } from '../../../bindings/invoke-result'
import {
  copyBodyFileIntoWorkspace,
  pickBodyFile,
  type BodyFileCommandError,
  type PickedBodyFile,
} from '../../../bindings/pick-body-file'
import type { BulkRow } from '../../../shared/bulk-edit'
import { useLanguage } from '../../../shared/i18n/use-language'
import { onSecuritySettingsChanged } from '../../../shared/security/sensitive-sync'
import { Button } from '../../../shared/ui/Button'
import { bodyFilePaths, codeLanguageForRaw, fileNameOf } from '../body-state'
import { rawBodyFormatter } from '../request-body-format'
import { formatSize } from '../response-summary'
import type { BodyState, BodyType, FormDataEntry, UrlEncodedEntry } from '../request-workbench.types'
import type { BodySchema } from '../schema-completions'
import { BinaryBodyPanel } from './BinaryBodyPanel'
import { FormDataPanel } from './FormDataPanel'
import { OptionSelect, type SelectOption } from './OptionSelect'
import { RequestBodyPanel } from './RequestBodyPanel'
import { UrlEncodedPanel } from './UrlEncodedPanel'
import './rest-body.css'

const BODY_TYPES = [
  { value: 'none', labelKey: 'requestBody.typeNone' },
  { value: 'formData', labelKey: 'requestBody.typeFormData' },
  { value: 'urlencoded', labelKey: 'requestBody.typeUrlEncoded' },
  { value: 'raw', labelKey: 'requestBody.typeRaw' },
  { value: 'binary', labelKey: 'requestBody.typeBinary' },
] as const satisfies readonly { value: BodyType; labelKey: string }[]

/** State of each body file path (missing, blocked…), checked again when the
 * list changes, when the window regains focus (the file may have been
 * created or moved in another program), when the security settings change,
 * and when `refresh` changes (a file was just picked or copied). */
function useBodyFileStatuses(
  paths: string[],
  rootPath: string,
  checkFiles: (rootPath: string, paths: string[]) => Promise<BodyFileStatus[]>,
  refresh: number,
): ReadonlyMap<string, BodyFileStatus> {
  const key = paths.join('\n')
  const [statuses, setStatuses] = useState<ReadonlyMap<string, BodyFileStatus>>(() => new Map())

  useEffect(() => {
    const current = key ? key.split('\n') : []
    let cancelled = false
    const check = () => {
      void checkFiles(rootPath, current).then((result) => {
        if (!cancelled) setStatuses(new Map(current.map((path, index) => [path, result[index] ?? 'ok'])))
      })
    }
    check()
    window.addEventListener('focus', check)
    const unsubscribe = onSecuritySettingsChanged(check)
    return () => {
      cancelled = true
      window.removeEventListener('focus', check)
      unsubscribe()
    }
  }, [key, rootPath, checkFiles, refresh])

  return statuses
}

/** A file just picked outside the workspace, offered to be copied into it. */
interface CopyOffer {
  picked: PickedBodyFile
  apply: (path: string) => void
  error: string | null
}

interface RestBodyPanelProps {
  body: BodyState
  /** Raiz do workspace: arquivos escolhidos dentro dela são salvos com
   * caminho relativo. */
  rootPath: string
  onTypeChange: (type: BodyType) => void
  onRawLanguageChange: (language: RawBodyLanguage) => void
  onRawChange: (value: string) => void
  onAddUrlEncoded: () => void
  onUpdateUrlEncoded: (id: string, patch: Partial<Omit<UrlEncodedEntry, 'id'>>) => void
  onRemoveUrlEncoded: (id: string) => void
  onReplaceUrlEncoded: (rows: BulkRow[]) => void
  onAddFormData: () => void
  onUpdateFormData: (id: string, patch: Partial<Omit<FormDataEntry, 'id'>>) => void
  onRemoveFormData: (id: string) => void
  onBinaryFileChange: (filePath: string) => void
  /** Variáveis do ambiente ativo — destaque, tooltip e sugestões de `{{variável}}` no corpo raw e nos campos url-encoded/form-data. */
  environmentVariables: EnvironmentVariableDto[]
  /** Schema do corpo (documentação importada) para sugerir chaves e valores
   * no corpo raw JSON; `null`/ausente = sem sugestões. */
  bodySchema?: BodySchema | null
  /** Injectable for tests; the native dialog through the backend by default. */
  pickFile?: (rootPath: string, currentPath: string) => Promise<PickedBodyFile | null>
  /** Injectable for tests; asks the backend by default. */
  checkFiles?: (rootPath: string, paths: string[]) => Promise<BodyFileStatus[]>
  /** Injectable for tests; copies through the backend by default. */
  copyFile?: (rootPath: string, filePath: string) => Promise<CommandResult<{ path: string }, BodyFileCommandError>>
  /** Exposes the raw body editor to the agent (ADR 0064); only the workbench sets it. */
  agentEditors?: boolean
  /** Keeps the raw editor's undo history across remounts (see `RequestBodyPanel`). */
  historyKey?: string
}

/** Aba "Body" de uma requisição REST: seletor do tipo de corpo e o editor
 * correspondente ao tipo escolhido. */
export function RestBodyPanel({
  body,
  rootPath,
  onTypeChange,
  onRawLanguageChange,
  onRawChange,
  onAddUrlEncoded,
  onUpdateUrlEncoded,
  onRemoveUrlEncoded,
  onReplaceUrlEncoded,
  onAddFormData,
  onUpdateFormData,
  onRemoveFormData,
  onBinaryFileChange,
  environmentVariables,
  bodySchema = null,
  agentEditors = false,
  historyKey,
  pickFile = pickBodyFile,
  checkFiles = checkBodyFiles,
  copyFile = copyBodyFileIntoWorkspace,
}: RestBodyPanelProps) {
  const { t } = useLanguage()
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const filePaths = useMemo(() => bodyFilePaths(body), [body])
  const [refresh, setRefresh] = useState(0)
  const fileStatuses = useBodyFileStatuses(filePaths, rootPath, checkFiles, refresh)
  const [copyOffer, setCopyOffer] = useState<CopyOffer | null>(null)
  const [copying, setCopying] = useState(false)

  // The backend saves a file inside the workspace with a relative path and
  // grants one outside it for this workspace (spec 0163).
  const pickInto = (currentPath: string, apply: (path: string) => void) => {
    void pickFile(rootPath, currentPath).then((picked) => {
      if (!picked) return
      apply(picked.path)
      setRefresh((value) => value + 1)
      setCopyOffer(picked.outsideWorkspace ? { picked, apply, error: null } : null)
    })
  }

  const copyIntoWorkspace = async (offer: CopyOffer) => {
    setCopying(true)
    const result = await copyFile(rootPath, offer.picked.path)
    setCopying(false)
    if (result.ok) {
      offer.apply(result.value.path)
      setCopyOffer(null)
      setRefresh((value) => value + 1)
    } else {
      const message = result.error.kind === 'notGranted' ? t('requestBody.copyNotGranted') : result.error.message
      setCopyOffer({ ...offer, error: message })
    }
  }

  const languageOptions: SelectOption<RawBodyLanguage>[] = [
    { value: 'text', label: t('requestBody.languageText') },
    { value: 'javascript', label: t('requestBody.languageJavaScript') },
    { value: 'json', label: t('requestBody.languageJson') },
    { value: 'html', label: t('requestBody.languageHtml') },
    { value: 'xml', label: t('requestBody.languageXml') },
  ]

  // Grupo de rádio com foco itinerante: setas movem e selecionam, como um
  // `<input type="radio">` nativo.
  const onTypeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    const next = (index + delta + BODY_TYPES.length) % BODY_TYPES.length
    onTypeChange(BODY_TYPES[next].value)
    optionRefs.current[next]?.focus()
  }

  return (
    <div className="rw-panel rw-rest-body-panel">
      <div className="rw-body-type-bar">
        <div className="rw-body-type-group" role="radiogroup" aria-label={t('requestBody.typeAria')}>
          {BODY_TYPES.map((option, index) => {
            const checked = body.type === option.value
            return (
              <button
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className="rw-body-type-option"
                onClick={() => onTypeChange(option.value)}
                onKeyDown={(event) => onTypeKeyDown(event, index)}
              >
                <span className="rw-body-type-dot" aria-hidden="true" />
                {t(option.labelKey)}
              </button>
            )
          })}
        </div>
        {body.type === 'raw' && (
          <div className="rw-body-language">
            <label className="rw-visually-hidden" htmlFor="rest-body-language">
              {t('requestBody.languageAria')}
            </label>
            <OptionSelect id="rest-body-language" value={body.rawLanguage} options={languageOptions} onChange={onRawLanguageChange} />
          </div>
        )}
      </div>

      <div className="rw-body-content">
        {copyOffer && (body.type === 'formData' || body.type === 'binary') && (
          <div className="rw-body-copy-offer" role="status">
            <div className="rw-body-copy-offer-text">
              <span>
                {t('requestBody.copyOffer', {
                  name: fileNameOf(copyOffer.picked.path),
                  size: formatSize(copyOffer.picked.sizeBytes),
                })}
              </span>
              <span className="rw-body-copy-offer-hint">{t('requestBody.copyOfferHint')}</span>
              {copyOffer.error && <span className="rw-body-copy-offer-error">{copyOffer.error}</span>}
            </div>
            <div className="rw-body-copy-offer-actions">
              <Button variant="primary" disabled={copying} onClick={() => void copyIntoWorkspace(copyOffer)}>
                {t('requestBody.copyIntoWorkspace')}
              </Button>
              <Button variant="ghost" onClick={() => setCopyOffer(null)}>
                {t('requestBody.keepPath')}
              </Button>
            </div>
          </div>
        )}
        {body.type === 'none' && <p className="rw-body-empty">{t('requestBody.noneHint')}</p>}
        {body.type === 'raw' && (
          <RequestBodyPanel
            value={body.raw}
            onChange={onRawChange}
            language={codeLanguageForRaw(body.rawLanguage)}
            environmentVariables={environmentVariables}
            bodySchema={body.rawLanguage === 'json' ? bodySchema : null}
            agentSlot={agentEditors ? 'body' : undefined}
            jsonComments
            historyKey={historyKey}
            formatter={rawBodyFormatter(body.rawLanguage)}
          />
        )}
        {body.type === 'urlencoded' && (
          <UrlEncodedPanel
            fields={body.urlEncoded}
            onAdd={onAddUrlEncoded}
            onUpdate={onUpdateUrlEncoded}
            onRemove={onRemoveUrlEncoded}
            onReplaceAll={onReplaceUrlEncoded}
            environmentVariables={environmentVariables}
          />
        )}
        {body.type === 'formData' && (
          <FormDataPanel
            fields={body.formData}
            onAdd={onAddFormData}
            onUpdate={onUpdateFormData}
            onRemove={onRemoveFormData}
            onPickFile={pickInto}
            fileStatuses={fileStatuses}
            environmentVariables={environmentVariables}
          />
        )}
        {body.type === 'binary' && (
          <BinaryBodyPanel
            filePath={body.binaryFilePath}
            onChange={onBinaryFileChange}
            onPickFile={pickInto}
            status={fileStatuses.get(body.binaryFilePath)}
          />
        )}
      </div>
    </div>
  )
}
