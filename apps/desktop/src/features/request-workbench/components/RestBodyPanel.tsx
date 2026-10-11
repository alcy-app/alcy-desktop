import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { RawBodyLanguage } from '../../../bindings/execute-rest-request'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { checkBodyFiles } from '../../../bindings/check-body-files'
import { pickBodyFile } from '../../../bindings/pick-body-file'
import type { BulkRow } from '../../../shared/bulk-edit'
import { useLanguage } from '../../../shared/i18n/use-language'
import { bodyFilePaths, codeLanguageForRaw, toWorkspaceRelativePath } from '../body-state'
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

/** Caminhos (dentre `paths`) que não existem nesta máquina — reconsultado
 * quando a lista muda e quando a janela volta ao foco (o usuário pode ter
 * criado/movido o arquivo em outro programa). */
function useMissingBodyFiles(
  paths: string[],
  rootPath: string,
  checkFiles: (rootPath: string, paths: string[]) => Promise<boolean[]>,
): ReadonlySet<string> {
  const key = paths.join('\n')
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const current = key ? key.split('\n') : []
    let cancelled = false
    const check = () => {
      void checkFiles(rootPath, current).then((exists) => {
        if (!cancelled) setMissing(new Set(current.filter((_, index) => exists[index] === false)))
      })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      window.removeEventListener('focus', check)
    }
  }, [key, rootPath, checkFiles])

  return missing
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
  /** Injetável para testes; o diálogo nativo por padrão. */
  pickFile?: () => Promise<string | null>
  /** Injetável para testes; consulta o backend por padrão. */
  checkFiles?: (rootPath: string, paths: string[]) => Promise<boolean[]>
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
  pickFile = pickBodyFile,
  checkFiles = checkBodyFiles,
}: RestBodyPanelProps) {
  const { t } = useLanguage()
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const filePaths = useMemo(() => bodyFilePaths(body), [body])
  const missingFiles = useMissingBodyFiles(filePaths, rootPath, checkFiles)

  const pickWorkspaceFile = async () => {
    const path = await pickFile()
    return path ? toWorkspaceRelativePath(path, rootPath) : null
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
        {body.type === 'none' && <p className="rw-body-empty">{t('requestBody.noneHint')}</p>}
        {body.type === 'raw' && (
          <RequestBodyPanel
            value={body.raw}
            onChange={onRawChange}
            language={codeLanguageForRaw(body.rawLanguage)}
            environmentVariables={environmentVariables}
            bodySchema={body.rawLanguage === 'json' ? bodySchema : null}
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
            onPickFile={pickWorkspaceFile}
            missingFiles={missingFiles}
            environmentVariables={environmentVariables}
          />
        )}
        {body.type === 'binary' && (
          <BinaryBodyPanel
            filePath={body.binaryFilePath}
            onChange={onBinaryFileChange}
            onPickFile={pickWorkspaceFile}
            missing={missingFiles.has(body.binaryFilePath)}
          />
        )}
      </div>
    </div>
  )
}
