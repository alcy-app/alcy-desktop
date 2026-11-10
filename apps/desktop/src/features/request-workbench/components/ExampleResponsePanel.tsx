import { useState } from 'react'
import type { RawBodyLanguage } from '../../../bindings/execute-rest-request'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { BulkRow } from '../../../shared/bulk-edit'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Input } from '../../../shared/ui/Input'
import { Tabs } from '../../../shared/ui/Tabs'
import { codeLanguageForRaw } from '../body-state'
import type { ExampleResponse } from '../collection-tree'
import type { HeaderEntry } from '../request-workbench.types'
import { HeadersPanel } from './HeadersPanel'
import { OptionSelect, type SelectOption } from './OptionSelect'
import { RequestBodyPanel } from './RequestBodyPanel'
import './example-response.css'

type ExampleResponseTab = 'body' | 'headers'

const TABS: { id: ExampleResponseTab; label: string }[] = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
]

interface ExampleResponsePanelProps {
  /** Tab showing the example; one editor per tab keeps undo history from crossing examples. */
  tabId: string
  response: ExampleResponse
  onChange: (patch: Partial<ExampleResponse>) => void
  environmentVariables: EnvironmentVariableDto[]
}

/** Editable response of a request example, shown where a tab's real response would be (spec 0156). */
export function ExampleResponsePanel({ tabId, response, onChange, environmentVariables }: ExampleResponsePanelProps) {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState<ExampleResponseTab>('body')

  const languageOptions: SelectOption<RawBodyLanguage>[] = [
    { value: 'text', label: t('requestBody.languageText') },
    { value: 'javascript', label: t('requestBody.languageJavaScript') },
    { value: 'json', label: t('requestBody.languageJson') },
    { value: 'html', label: t('requestBody.languageHtml') },
    { value: 'xml', label: t('requestBody.languageXml') },
  ]

  // Rows are identified by position: the example's headers have no ids of their own.
  const headers: HeaderEntry[] = response.headers.map((header, index) => ({ id: String(index), ...header }))
  const updateHeader = (id: string, patch: Partial<Omit<HeaderEntry, 'id'>>) =>
    onChange({ headers: response.headers.map((header, index) => (String(index) === id ? { ...header, ...patch } : header)) })
  const removeHeader = (id: string) => onChange({ headers: response.headers.filter((_, index) => String(index) !== id) })
  const addHeader = () => onChange({ headers: [...response.headers, { name: '', value: '', enabled: true }] })
  const replaceHeaders = (rows: BulkRow[]) => onChange({ headers: rows })

  const setStatusCode = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 3)
    onChange({ statusCode: digits === '' ? 0 : Number(digits) })
  }

  return (
    <section className="rw-response rw-example-response" aria-label={t('exampleResponse.sectionLabel')}>
      <div className="rw-response-toolbar">
        <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} ariaLabel={t('exampleResponse.sectionLabel')} idPrefix="example-response-" />
        <label className="rw-example-response-status">
          <span>{t('exampleResponse.statusCode')}</span>
          <Input
            className="rw-example-response-status-input"
            inputMode="numeric"
            value={response.statusCode === 0 ? '' : String(response.statusCode)}
            onChange={(event) => setStatusCode(event.target.value)}
          />
        </label>
      </div>

      {activeTab === 'body' ? (
        <div className="rw-example-response-body">
          <div className="rw-example-response-language">
            <label className="rw-visually-hidden" htmlFor="example-response-language">
              {t('exampleResponse.languageAria')}
            </label>
            <OptionSelect
              id="example-response-language"
              value={response.language}
              options={languageOptions}
              onChange={(language) => onChange({ language })}
            />
          </div>
          <div className="rw-body-content">
            <RequestBodyPanel
              key={tabId}
              value={response.body}
              onChange={(body) => onChange({ body })}
              language={codeLanguageForRaw(response.language)}
              label={t('exampleResponse.bodyLabel')}
              environmentVariables={environmentVariables}
            />
          </div>
        </div>
      ) : (
        <div className="rw-tabpanel">
          <HeadersPanel
            headers={headers}
            onAdd={addHeader}
            onUpdate={updateHeader}
            onRemove={removeHeader}
            onReplaceAll={replaceHeaders}
            environmentVariables={environmentVariables}
          />
        </div>
      )}
    </section>
  )
}
