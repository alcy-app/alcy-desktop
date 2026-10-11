import { useMemo, useState } from 'react'
import { RequestPicker } from './RequestPicker'
import { useLanguage } from '../../shared/i18n/use-language'
import { Badge } from '../../shared/ui/Badge'
import { Button } from '../../shared/ui/Button'
import { Checkbox } from '../../shared/ui/Checkbox'
import { Field } from '../../shared/ui/Field'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { Textarea } from '../../shared/ui/Textarea'
import { CloseIcon, PlusIcon, SearchIcon, TrashIcon } from '../../shared/ui/icons'
import { useToast } from '../../shared/ui/use-toast'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { describeVariable } from '../request-workbench/template-highlight'
import type { RequestSummary, TreeNode } from '../request-workbench/collection-tree'
import type { ComparisonOperatorState, ConditionState, LoadNodeKindState, SimpleNodeKindState, VariableAssignmentState } from './flows.types'
import { SIMPLE_NODE_LABEL_KEY } from './simple-node-types'
import { LOAD_NODE_DEFINITIONS } from './load-node-config'
import type { MockServerSummaryDto } from '../../bindings/mock-servers'
import { MockNodeFields } from './MockNodeFields'
import type { MockStartInfo } from './mock-nodes'

export type InspectorSelection =
  | { id: string; kind: 'start' }
  | { id: string; kind: 'block'; label: string }
  | { id: string; kind: 'request'; requestId: string; request: RequestSummary | null }
  | { id: string; kind: 'if'; condition: ConditionState }
  | { id: string; kind: 'load'; loadKind: LoadNodeKindState; label: string; config: string }
  | ({ id: string } & SimpleNodeKindState)

export interface AncestorRequestRef {
  nodeId: string
  label: string
  /** O que o node expõe para referência: a resposta de uma requisição (padrão),
   * a chamada recebida por um "Aguardar chamada" ou a URL de um "Ligar mock". */
  output?: 'response' | 'mockRequest' | 'mockServer'
}

interface NodeInspectorPanelProps {
  selection: InspectorSelection
  ancestorRequests: AncestorRequestRef[]
  /** Nomes definidos por nodes `setVariables` ancestrais. */
  ancestorLocalVariables: string[]
  environmentVariables: EnvironmentVariableDto[]
  collections: TreeNode[]
  onLabelChange: (nodeId: string, label: string) => void
  onConditionChange: (nodeId: string, condition: ConditionState) => void
  onRequestChange: (nodeId: string, request: RequestSummary) => void
  onConfigChange: (nodeId: string, config: SimpleNodeKindState) => void
  onLoadConfigChange: (nodeId: string, config: string) => void
  onImportDatasetAsset?: () => Promise<{ assetId: string; rows: number } | null>
  /** Abre a requisição avulsa numa aba do workbench. */
  onEditInlineRequest: (nodeId: string) => void
  /** Blocos de mock (spec 0121): "Ligar mock" ancestrais, o mock do bloco
   * selecionado e os mocks salvos do workspace. */
  mockStartOptions: MockStartInfo[]
  selectedMockStart: MockStartInfo | null
  savedMockServers: MockServerSummaryDto[]
  /** Abre o mock avulso numa aba do workbench. */
  onEditInlineMockServer: (nodeId: string) => void
  onClose: () => void
}

/** Maior espera aceita pelo motor (`MAX_SLEEP_MS` em `execute_flow.rs`). */
const MAX_SLEEP_MS = 10 * 60 * 1000
/** Maior limite de iterações aceito pelo motor (`MAX_WHILE_ITERATIONS`). */
const MAX_WHILE_ITERATIONS = 10_000

function methodLabel(request: RequestSummary): string {
  if (request.protocol === 'graphql') return 'GraphQL'
  return request.content.method.toUpperCase()
}

/** Painel que abre ao selecionar um node no canvas — conteúdo específico por
 * kind (não um schema genérico, já que `Block`/`Request` não têm campos de
 * configuração no domínio além do que já é mostrado aqui). */
const OPERATOR_OPTIONS: { value: ComparisonOperatorState; labelKey: 'flows.canvas.conditionOperatorEquals' | 'flows.canvas.conditionOperatorNotEquals' | 'flows.canvas.conditionOperatorGreaterThan' | 'flows.canvas.conditionOperatorLessThan' }[] = [
  { value: 'equals', labelKey: 'flows.canvas.conditionOperatorEquals' },
  { value: 'notEquals', labelKey: 'flows.canvas.conditionOperatorNotEquals' },
  { value: 'greaterThan', labelKey: 'flows.canvas.conditionOperatorGreaterThan' },
  { value: 'lessThan', labelKey: 'flows.canvas.conditionOperatorLessThan' },
]

export function NodeInspectorPanel({
  selection,
  ancestorRequests,
  ancestorLocalVariables,
  environmentVariables,
  collections,
  onLabelChange,
  onConditionChange,
  onRequestChange,
  onConfigChange,
  onLoadConfigChange,
  onImportDatasetAsset,
  onEditInlineRequest,
  mockStartOptions,
  selectedMockStart,
  savedMockServers,
  onEditInlineMockServer,
  onClose,
}: NodeInspectorPanelProps) {
  const { t } = useLanguage()
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null)

  const title =
    selection.kind === 'start'
      ? t('flows.canvas.inspectorStartTitle')
      : selection.kind === 'block'
        ? t('flows.canvas.inspectorBlockTitle')
        : selection.kind === 'if'
          ? t('flows.canvas.inspectorIfTitle')
          : selection.kind === 'request'
            ? t('flows.canvas.inspectorRequestTitle')
            : selection.kind === 'load'
              ? t(LOAD_NODE_DEFINITIONS[selection.loadKind].labelKey)
              : t(SIMPLE_NODE_LABEL_KEY[selection.kind])
  const changeConfig = (config: SimpleNodeKindState) => onConfigChange(selection.id, config)

  return (
    <aside className="flow-inspector-panel">
      <header className="flow-inspector-header">
        <h3>{title}</h3>
        <IconButton icon={<CloseIcon size={12} />} label={t('flows.canvas.inspectorCloseAria')} onClick={onClose} />
      </header>

      <div className="flow-inspector-body">
        {selection.kind === 'start' && <p className="flow-inspector-hint">{t('flows.canvas.inspectorStartDescription')}</p>}

        {selection.kind === 'block' && (
          <div className="flow-inspector-field">
            <label className="flow-inspector-field-label" htmlFor="flow-inspector-block-label">
              {t('flows.canvas.inspectorBlockLabelAria')}
            </label>
            <InlineEditInput
              id="flow-inspector-block-label"
              value={selection.label}
              aria-label={t('flows.canvas.inspectorBlockLabelAria')}
              onChange={(event) => onLabelChange(selection.id, event.target.value)}
            />
          </div>
        )}

        {selection.kind === 'load' && (
          <LoadNodeFields
            key={selection.id}
            label={selection.label}
            loadKind={selection.loadKind}
            config={selection.config}
            onLabelChange={(label) => onLabelChange(selection.id, label)}
            onConfigChange={(config) => onLoadConfigChange(selection.id, config)}
            onImportDatasetAsset={onImportDatasetAsset}
          />
        )}

        {selection.kind === 'request' && (
          <>
            {selection.request ? (
              <div className="flow-inspector-request-summary">
                <div className="flow-inspector-request-heading">
                  <Badge tone="accent">{methodLabel(selection.request)}</Badge>
                  <span>{selection.request.name || t('common.unnamed')}</span>
                </div>
                <p className="flow-inspector-request-url">{selection.request.content.endpointUrl}</p>
              </div>
            ) : (
              <p className="flow-inspector-hint">
                {selection.requestId === '' ? t('flows.canvas.requestNodeUnconfiguredHint') : t('flows.canvas.requestNodeMissing')}
              </p>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => setPickerAnchor(event.currentTarget.getBoundingClientRect())}
            >
              {selection.request ? t('flows.canvas.changeRequestLabel') : t('flows.canvas.chooseRequestLabel')}
            </Button>
            {pickerAnchor && (
              <RequestPicker
                anchor={pickerAnchor}
                collections={collections}
                onClose={() => setPickerAnchor(null)}
                onSelectRequest={(request) => {
                  onRequestChange(selection.id, request)
                  setPickerAnchor(null)
                }}
              />
            )}
          </>
        )}

        {selection.kind === 'if' && (
          <ConditionFields
            condition={selection.condition}
            onChange={(condition) => onConditionChange(selection.id, condition)}
          />
        )}

        {selection.kind === 'note' && (
          <Field label={t('flows.canvas.noteTextAria')}>
            <Textarea
              rows={6}
              value={selection.text}
              placeholder={t('flows.canvas.notePlaceholder')}
              onChange={(event) => changeConfig({ ...selection, text: event.target.value })}
            />
          </Field>
        )}

        {selection.kind === 'log' && (
          <Field label={t('flows.canvas.logMessageLabel')} hint={t('flows.canvas.logHint')}>
            <Textarea
              mono
              rows={4}
              value={selection.message}
              placeholder={t('flows.canvas.logMessagePlaceholder')}
              onChange={(event) => changeConfig({ kind: 'log', message: event.target.value })}
            />
          </Field>
        )}

        {selection.kind === 'display' && (
          <Field label={t('flows.canvas.displayTemplateLabel')} hint={t('flows.canvas.displayHint')}>
            <Textarea
              mono
              rows={3}
              value={selection.template}
              placeholder={t('flows.canvas.displayTemplatePlaceholder')}
              onChange={(event) => changeConfig({ kind: 'display', template: event.target.value })}
            />
          </Field>
        )}

        {selection.kind === 'sleep' && (
          <SleepFields
            key={selection.id}
            durationMs={selection.durationMs}
            onChange={(durationMs) => changeConfig({ kind: 'sleep', durationMs })}
          />
        )}

        {selection.kind === 'inlineRequest' && (
          <>
            <p className="flow-inspector-hint">{t('flows.canvas.inlineRequestHint')}</p>
            <InlineRequestNameField
              key={selection.id}
              name={selection.request.name}
              onChange={(name) => changeConfig({ kind: 'inlineRequest', request: { ...selection.request, name } })}
            />
            <div className="flow-inspector-request-summary">
              <div className="flow-inspector-request-heading">
                <Badge tone="accent">{methodLabel(selection.request)}</Badge>
                <span>{selection.request.name}</span>
              </div>
              <p className="flow-inspector-request-url">{selection.request.content.endpointUrl || t('flows.canvas.inlineRequestEmptyUrl')}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onEditInlineRequest(selection.id)}>
              {t('flows.canvas.editInlineRequestLabel')}
            </Button>
          </>
        )}

        {(selection.kind === 'mockStart' ||
          selection.kind === 'mockStop' ||
          selection.kind === 'mockWaitRequest' ||
          selection.kind === 'mockSetResponse' ||
          selection.kind === 'mockAssertCalls') && (
          <MockNodeFields
            nodeId={selection.id}
            config={selection}
            startOptions={mockStartOptions}
            start={selectedMockStart}
            savedServers={savedMockServers}
            onChange={changeConfig}
            onEditInlineMockServer={onEditInlineMockServer}
          />
        )}

        {selection.kind === 'while' && (
          <>
            <p className="flow-inspector-hint">{t('flows.canvas.whileHint')}</p>
            <ConditionFields
              condition={selection.condition}
              onChange={(condition) => changeConfig({ ...selection, condition })}
            />
            <Field label={t('flows.canvas.whileMaxIterationsLabel')}>
              <Input
                key={selection.id}
                type="number"
                min={1}
                max={MAX_WHILE_ITERATIONS}
                step={1}
                defaultValue={String(selection.maxIterations)}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10)
                  if (Number.isNaN(value)) return
                  changeConfig({ ...selection, maxIterations: Math.min(MAX_WHILE_ITERATIONS, Math.max(1, value)) })
                }}
              />
            </Field>
          </>
        )}

        {selection.kind === 'setVariables' && (
          <AssignmentFields
            key={selection.id}
            assignments={selection.assignments}
            onChange={(assignments) => changeConfig({ kind: 'setVariables', assignments })}
          />
        )}

        {(selection.kind === 'request' ||
          selection.kind === 'inlineRequest' ||
          selection.kind === 'if' ||
          selection.kind === 'while' ||
          selection.kind === 'log' ||
          selection.kind === 'display' ||
          selection.kind === 'setVariables') && (
          <VariablesSection
            ancestorRequests={ancestorRequests}
            localVariables={ancestorLocalVariables}
            environmentVariables={environmentVariables}
          />
        )}
      </div>
    </aside>
  )
}

interface LoadNodeFieldsProps {
  label: string
  loadKind: LoadNodeKindState
  config: string
  onLabelChange: (label: string) => void
  onConfigChange: (config: string) => void
  onImportDatasetAsset?: () => Promise<{ assetId: string; rows: number } | null>
}

/** A configuração de carga é mantida como JSON canônico no grafo. Este
 * editor aceita apenas objeto JSON: a validação semântica permanece no Rust
 * no preview, antes de qualquer request. */
function LoadNodeFields({ label, loadKind, config, onLabelChange, onConfigChange, onImportDatasetAsset }: LoadNodeFieldsProps) {
  const { t } = useLanguage()
  const [draft, setDraft] = useState(config)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseLoadConfig(config)

  const structuredFields = parsed !== null && (
    loadKind === 'forEach' ? (
      <ForEachLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'select' ? (
      <SelectLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'repeat' ? (
      <RepeatLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'timeBox' ? (
      <TimeBoxLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'timer' ? (
      <TimerLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'check' ? (
      <CheckLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'extract' ? (
      <ExtractLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'script' ? (
      <ScriptLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'group' ? (
      <GroupLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'metric' ? (
      <MetricLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'threshold' ? (
      <ThresholdLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'request' ? (
      <RequestLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'configureSession' ? (
      <ConfigureSessionLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'oncePerVu' ? (
      <OncePerVuLoadFields />
    ) : loadKind === 'scenario' ? (
      <ScenarioLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} />
    ) : loadKind === 'dataset' ? (
      <DatasetLoadFields config={parsed} onChange={(next) => onConfigChange(JSON.stringify(next))} onImportAsset={onImportDatasetAsset} />
    ) : null
  )

  return (
    <>
      <Field label={t('flows.loadNode.labelField')}>
        <Input value={label} onChange={(event) => onLabelChange(event.target.value)} />
      </Field>
      {structuredFields ?? (
        <Field label={t('flows.loadNode.configField')} hint={t('flows.loadNode.configHint')}>
          <Textarea
            mono
            rows={12}
            value={draft}
            spellCheck={false}
            aria-invalid={error !== null}
            onChange={(event) => {
              const next = event.target.value
              setDraft(next)
              try {
                const value: unknown = JSON.parse(next)
                if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(t('flows.loadNode.configObjectError'))
                setError(null)
                onConfigChange(JSON.stringify(value))
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : t('flows.loadNode.configInvalidError'))
              }
            }}
          />
          {error && <p className="flow-inspector-hint" role="alert">{t('flows.loadNode.configInvalidError')}: {error}</p>}
        </Field>
      )}
    </>
  )
}

type LoadConfig = Record<string, unknown>

function parseLoadConfig(config: string): LoadConfig | null {
  try {
    const value: unknown = JSON.parse(config)
    return value !== null && !Array.isArray(value) && typeof value === 'object' ? value as LoadConfig : null
  } catch {
    return null
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function asNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function asHttpStatus(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function withoutKeys(config: LoadConfig, keys: string[]): LoadConfig {
  const next = { ...config }
  for (const key of keys) delete next[key]
  return next
}

function tagsToText(value: unknown): string {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return ''
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, tag]) => `${key}=${tag}`)
    .join('\n')
}

function parseTags(draft: string): Record<string, string> | null {
  const tags: Record<string, string> = {}
  for (const line of draft.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    if (separator <= 0 || !key || Object.hasOwn(tags, key)) return null
    tags[key] = line.slice(separator + 1).trim()
  }
  return tags
}

function KeyValueLoadField({
  label,
  hint,
  values,
  onChange,
}: {
  label: string
  hint: string
  values: unknown
  onChange: (values: Record<string, string>) => void
}) {
  const { t } = useLanguage()
  const [draft, setDraft] = useState(() => tagsToText(values))
  const [error, setError] = useState<string | undefined>()
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => <Textarea
        id={id}
        mono
        rows={4}
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          const parsed = parseTags(next)
          if (parsed === null) {
            setError(t('flows.loadNode.tagsInvalid'))
            return
          }
          setError(undefined)
          onChange(parsed)
        }}
      />}
    </Field>
  )
}

function TagsLoadField({ tags, onChange }: { tags: unknown; onChange: (tags: Record<string, string>) => void }) {
  const { t } = useLanguage()
  return <KeyValueLoadField label={t('flows.loadNode.tags')} hint={t('flows.loadNode.tagsHint')} values={tags} onChange={onChange} />
}

interface LoadHeader {
  name: string
  value: string
  enabled: boolean
}

function loadHeaders(value: unknown): LoadHeader[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((header): LoadHeader[] => {
    if (header === null || Array.isArray(header) || typeof header !== 'object') return []
    const record = header as Record<string, unknown>
    return [{
      name: asString(record.name, ''),
      value: asString(record.value, ''),
      enabled: record.enabled !== false,
    }]
  })
}

function HeadersLoadField({ headers, onChange }: { headers: unknown; onChange: (headers: LoadHeader[]) => void }) {
  const { t } = useLanguage()
  const values = loadHeaders(headers)
  const update = (index: number, changes: Partial<LoadHeader>) => onChange(
    values.map((header, current) => current === index ? { ...header, ...changes } : header),
  )
  return (
    <div className="flow-inspector-assignments">
      <p className="flow-inspector-hint">{t('flows.loadNode.headersHint')}</p>
      {values.map((header, index) => (
        <div key={`${index}-${header.name}`} className="flow-inspector-assignment">
          <div className="flow-inspector-assignment-header">
            <Input
              mono
              value={header.name}
              placeholder={t('flows.loadNode.headerName')}
              aria-label={t('flows.loadNode.headerName')}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <IconButton
              icon={<TrashIcon size={12} />}
              label={t('flows.loadNode.removeHeader', { name: header.name || String(index + 1) })}
              size="sm"
              onClick={() => onChange(values.filter((_, current) => current !== index))}
            />
          </div>
          <Input
            mono
            value={header.value}
            placeholder={t('flows.loadNode.headerValue')}
            aria-label={t('flows.loadNode.headerValue')}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <label className="flow-inspector-checkbox-row">
            <Checkbox checked={header.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />
            {t('flows.loadNode.headerEnabled')}
          </label>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...values, { name: '', value: '', enabled: true }])}>
        {t('flows.loadNode.addHeader')}
      </Button>
    </div>
  )
}

function RequestLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.request.method')}>
        {(id) => <Select id={id} value={asString(config.method, 'GET')} onChange={(event) => onChange({ ...config, method: event.target.value })}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => <option key={method} value={method}>{method}</option>)}
        </Select>}
      </Field>
      <Field label={t('flows.loadNode.request.url')}>
        {(id) => <Input id={id} mono value={asString(config.url, '')} onChange={(event) => onChange({ ...config, url: event.target.value })} />}
      </Field>
      <Field label={t('flows.loadNode.request.body')}>
        {(id) => <Textarea id={id} mono rows={5} value={asString(config.body, '')} onChange={(event) => onChange({ ...config, body: event.target.value })} />}
      </Field>
      <Field label={t('flows.loadNode.request.timeout')} hint={t('flows.loadNode.request.timeoutHint')}>
        {(id) => <Input
          id={id}
          type="number"
          min={0}
          step={1}
          value={config.timeoutMs === undefined ? '' : String(asNonNegativeInteger(config.timeoutMs, 0))}
          onChange={(event) => onChange(event.target.value === '' ? withoutKeys(config, ['timeoutMs']) : { ...config, timeoutMs: asNonNegativeInteger(Number(event.target.value), 0) })}
        />}
      </Field>
      <Field label={t('flows.loadNode.request.redirectPolicy')}>
        {(id) => <Select id={id} value={asString(config.redirectPolicy, 'follow')} onChange={(event) => onChange({ ...config, redirectPolicy: event.target.value })}>
          <option value="follow">{t('flows.loadNode.request.redirectFollow')}</option>
          <option value="manual">{t('flows.loadNode.request.redirectManual')}</option>
        </Select>}
      </Field>
      <HeadersLoadField headers={config.headers} onChange={(headers) => onChange({ ...config, headers })} />
      <TagsLoadField tags={config.tags} onChange={(tags) => onChange({ ...config, tags })} />
    </div>
  )
}

function ConfigureSessionLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <div className="flow-inspector-condition">
      <HeadersLoadField headers={config.headers} onChange={(headers) => onChange({ ...config, headers })} />
      <KeyValueLoadField
        label={t('flows.loadNode.configureSession.variables')}
        hint={t('flows.loadNode.configureSession.variablesHint')}
        values={config.variables}
        onChange={(variables) => onChange({ ...config, variables })}
      />
      <label className="flow-inspector-checkbox-row">
        <Checkbox
          checked={config.cookiesEnabled !== false}
          onChange={(event) => onChange({ ...config, cookiesEnabled: event.target.checked })}
        />
        {t('flows.loadNode.configureSession.cookiesEnabled')}
      </label>
    </div>
  )
}

function OncePerVuLoadFields() {
  const { t } = useLanguage()
  return <p className="flow-inspector-hint">{t('flows.loadNode.oncePerVu.hint')}</p>
}

type DatasetRow = Record<string, string>

function datasetRows(value: unknown): DatasetRow[] {
  if (!Array.isArray(value)) return [{ value: '' }]
  const rows = value.flatMap((row): DatasetRow[] => {
    if (row === null || Array.isArray(row) || typeof row !== 'object') return []
    const fields = Object.entries(row as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    return fields.length > 0 ? [Object.fromEntries(fields)] : []
  })
  return rows.length > 0 ? rows : [{ value: '' }]
}

function datasetColumns(rows: DatasetRow[]): string[] {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row).filter((name) => name.trim())))]
  return columns.length > 0 ? columns : ['value']
}

function DatasetLoadFields({ config, onChange, onImportAsset }: { config: LoadConfig; onChange: (config: LoadConfig) => void; onImportAsset?: () => Promise<{ assetId: string; rows: number } | null> }) {
  const { t } = useLanguage()
  const assetId = typeof config.assetId === 'string' ? config.assetId : null
  const rows = datasetRows(config.rows)
  const columns = datasetColumns(rows)
  const updateRows = (next: DatasetRow[]) => onChange({ ...config, rows: next })
  const setColumns = (draft: string) => {
    const nextColumns = [...new Set(draft.split('\n').map((name) => name.trim()).filter(Boolean))]
    if (nextColumns.length === 0) return
    updateRows(rows.map((row) => Object.fromEntries(nextColumns.map((column) => [column, row[column] ?? '']))))
  }
  const updateCell = (rowIndex: number, column: string, value: string) => updateRows(
    rows.map((row, current) => current === rowIndex ? { ...row, [column]: value } : row),
  )

  return (
    <div className="flow-inspector-condition">
      {onImportAsset && <Button variant="ghost" size="sm" onClick={() => void onImportAsset().then((asset) => {
        if (asset) onChange({ assetId: asset.assetId, recycle: config.recycle !== false })
      })}>{t('flows.loadNode.dataset.importAsset')}</Button>}
      {assetId ? <>
        <p className="flow-inspector-hint">{t('flows.loadNode.dataset.importedAsset', { assetId })}</p>
        <Button variant="ghost" size="sm" onClick={() => onChange({ rows: [{ value: '' }], recycle: config.recycle !== false })}>
          {t('flows.loadNode.dataset.useInlineRows')}
        </Button>
      </> : <>
      <Field label={t('flows.loadNode.dataset.columns')} hint={t('flows.loadNode.dataset.columnsHint')}>
        {(id) => <Textarea id={id} mono rows={3} value={columns.join('\n')} spellCheck={false} onChange={(event) => setColumns(event.target.value)} />}
      </Field>
      <div className="flow-inspector-assignments">
        <p className="flow-inspector-hint">{t('flows.loadNode.dataset.rowsHint')}</p>
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="flow-inspector-assignment">
            <div className="flow-inspector-assignment-header">
              <span className="flow-inspector-hint">{t('flows.loadNode.dataset.row', { index: String(rowIndex + 1) })}</span>
              <IconButton
                icon={<TrashIcon size={12} />}
                label={t('flows.loadNode.dataset.removeRow', { index: String(rowIndex + 1) })}
                size="sm"
                disabled={rows.length === 1}
                onClick={() => updateRows(rows.filter((_, current) => current !== rowIndex))}
              />
            </div>
            {columns.map((column) => <Input
              key={column}
              mono
              value={row[column] ?? ''}
              placeholder={column}
              aria-label={t('flows.loadNode.dataset.cell', { row: String(rowIndex + 1), column })}
              onChange={(event) => updateCell(rowIndex, column, event.target.value)}
            />)}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => updateRows([...rows, Object.fromEntries(columns.map((column) => [column, '']))])}>
          {t('flows.loadNode.dataset.addRow')}
        </Button>
      </div>
      </>}
      <label className="flow-inspector-checkbox-row">
        <Checkbox checked={config.recycle !== false} onChange={(event) => onChange({ ...config, recycle: event.target.checked })} />
        {t('flows.loadNode.dataset.recycle')}
      </label>
    </div>
  )
}

type ScenarioExecutor = 'sharedIterations' | 'perVuIterations' | 'constantVus' | 'rampingVus' | 'constantArrivalRate' | 'rampingArrivalRate'

const SCENARIO_EXECUTORS: readonly ScenarioExecutor[] = [
  'sharedIterations', 'perVuIterations', 'constantVus', 'rampingVus', 'constantArrivalRate', 'rampingArrivalRate',
]

function isScenarioExecutor(value: string): value is ScenarioExecutor {
  return SCENARIO_EXECUTORS.includes(value as ScenarioExecutor)
}

function scenarioConfig(executor: ScenarioExecutor): LoadConfig {
  switch (executor) {
    case 'sharedIterations': return { executor, vus: 1, iterations: 1 }
    case 'perVuIterations': return { executor, vus: 1, iterationsPerVu: 1 }
    case 'constantVus': return { executor, vus: 1, durationMs: 1000 }
    case 'rampingVus': return { executor, startVus: 1, stages: [{ target: 1, durationMs: 1000 }], gracefulRampDownMs: 0 }
    case 'constantArrivalRate': return { executor, rate: 1, timeUnitMs: 1000, durationMs: 1000, preAllocatedVus: 1 }
    case 'rampingArrivalRate': return { executor, startRate: 1, timeUnitMs: 1000, stages: [{ target: 1, durationMs: 1000 }], preAllocatedVus: 1 }
  }
}

function scenarioStages(value: unknown): { target: number; durationMs: number }[] {
  if (!Array.isArray(value)) return [{ target: 1, durationMs: 1000 }]
  const stages = value.flatMap((stage): { target: number; durationMs: number }[] => {
    if (stage === null || Array.isArray(stage) || typeof stage !== 'object') return []
    const record = stage as Record<string, unknown>
    return [{ target: asNonNegativeInteger(record.target, 0), durationMs: asPositiveInteger(record.durationMs, 1000) }]
  })
  return stages.length > 0 ? stages : [{ target: 1, durationMs: 1000 }]
}

function ScenarioStagesLoadField({ stages, onChange }: { stages: unknown; onChange: (stages: { target: number; durationMs: number }[]) => void }) {
  const { t } = useLanguage()
  const values = scenarioStages(stages)
  const update = (index: number, changes: Partial<{ target: number; durationMs: number }>) => onChange(
    values.map((stage, current) => current === index ? { ...stage, ...changes } : stage),
  )
  return (
    <div className="flow-inspector-assignments">
      <p className="flow-inspector-hint">{t('flows.loadNode.scenario.stagesHint')}</p>
      {values.map((stage, index) => (
        <div key={index} className="flow-inspector-assignment">
          <Input
            type="number"
            min={0}
            step={1}
            value={String(stage.target)}
            aria-label={t('flows.loadNode.scenario.stageTarget', { index: String(index + 1) })}
            onChange={(event) => update(index, { target: asNonNegativeInteger(Number(event.target.value), 0) })}
          />
          <Input
            type="number"
            min={1}
            step={1}
            value={String(stage.durationMs)}
            aria-label={t('flows.loadNode.scenario.stageDuration', { index: String(index + 1) })}
            onChange={(event) => update(index, { durationMs: asPositiveInteger(Number(event.target.value), 1) })}
          />
          <IconButton
            icon={<TrashIcon size={12} />}
            label={t('flows.loadNode.scenario.removeStage', { index: String(index + 1) })}
            size="sm"
            disabled={values.length === 1}
            onClick={() => onChange(values.filter((_, current) => current !== index))}
          />
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...values, { target: values.at(-1)?.target ?? 1, durationMs: 1000 }])}>
        {t('flows.loadNode.scenario.addStage')}
      </Button>
    </div>
  )
}

function ScenarioLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  const phase = asString(config.phase, 'scenario')
  const executorValue = asString(config.executor, 'sharedIterations')
  const executor: ScenarioExecutor = isScenarioExecutor(executorValue) ? executorValue : 'sharedIterations'
  const update = (changes: LoadConfig) => onChange({ ...config, ...changes })
  if (phase !== 'scenario') {
    return (
      <div className="flow-inspector-condition">
        <Field label={t('flows.loadNode.scenario.phase')}>
          {(id) => <Select id={id} value={phase} onChange={(event) => onChange(event.target.value === 'scenario' ? scenarioConfig('sharedIterations') : { phase: event.target.value, timeoutMs: asPositiveInteger(config.timeoutMs, 60_000) })}>
            <option value="scenario">{t('flows.loadNode.scenario.phaseScenario')}</option>
            <option value="setup">{t('flows.loadNode.scenario.phaseSetup')}</option>
            <option value="teardown">{t('flows.loadNode.scenario.phaseTeardown')}</option>
          </Select>}
        </Field>
        <Field label={t('flows.loadNode.scenario.lifecycleTimeout')}>
          {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.timeoutMs, 60_000))} onChange={(event) => update({ timeoutMs: asPositiveInteger(Number(event.target.value), 1) })} />}
        </Field>
      </div>
    )
  }
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.scenario.phase')}>
        {(id) => <Select id={id} value="scenario" onChange={(event) => onChange(event.target.value === 'scenario' ? config : { phase: event.target.value, timeoutMs: 60_000 })}>
          <option value="scenario">{t('flows.loadNode.scenario.phaseScenario')}</option>
          <option value="setup">{t('flows.loadNode.scenario.phaseSetup')}</option>
          <option value="teardown">{t('flows.loadNode.scenario.phaseTeardown')}</option>
        </Select>}
      </Field>
      <Field label={t('flows.loadNode.scenario.executor')}>
        {(id) => <Select id={id} value={executor} onChange={(event) => onChange(scenarioConfig(event.target.value as ScenarioExecutor))}>
          <option value="sharedIterations">{t('flows.loadNode.scenario.sharedIterations')}</option>
          <option value="perVuIterations">{t('flows.loadNode.scenario.perVuIterations')}</option>
          <option value="constantVus">{t('flows.loadNode.scenario.constantVus')}</option>
          <option value="rampingVus">{t('flows.loadNode.scenario.rampingVus')}</option>
          <option value="constantArrivalRate">{t('flows.loadNode.scenario.constantArrivalRate')}</option>
          <option value="rampingArrivalRate">{t('flows.loadNode.scenario.rampingArrivalRate')}</option>
        </Select>}
      </Field>
      {(executor === 'sharedIterations' || executor === 'perVuIterations' || executor === 'constantVus') && (
        <Field label={t('flows.loadNode.scenario.vus')}>
          {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.vus, 1))} onChange={(event) => update({ vus: asPositiveInteger(Number(event.target.value), 1) })} />}
        </Field>
      )}
      {executor === 'sharedIterations' && <Field label={t('flows.loadNode.scenario.iterations')}>
        {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.iterations, 1))} onChange={(event) => update({ iterations: asPositiveInteger(Number(event.target.value), 1) })} />}
      </Field>}
      {executor === 'perVuIterations' && <Field label={t('flows.loadNode.scenario.iterationsPerVu')}>
        {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.iterationsPerVu, 1))} onChange={(event) => update({ iterationsPerVu: asPositiveInteger(Number(event.target.value), 1) })} />}
      </Field>}
      {(executor === 'constantVus' || executor === 'constantArrivalRate') && <Field label={t('flows.loadNode.scenario.duration')}>
        {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.durationMs, 1000))} onChange={(event) => update({ durationMs: asPositiveInteger(Number(event.target.value), 1) })} />}
      </Field>}
      {(executor === 'sharedIterations' || executor === 'perVuIterations') && <Field label={t('flows.loadNode.scenario.maxDuration')} hint={t('flows.loadNode.scenario.maxDurationHint')}>
        {(id) => <Input id={id} type="number" min={1} step={1} value={config.maxDurationMs === undefined ? '' : String(asPositiveInteger(config.maxDurationMs, 1))} onChange={(event) => onChange(event.target.value === '' ? withoutKeys(config, ['maxDurationMs']) : { ...config, maxDurationMs: asPositiveInteger(Number(event.target.value), 1) })} />}
      </Field>}
      {(executor === 'rampingVus' || executor === 'rampingArrivalRate') && <ScenarioStagesLoadField stages={config.stages} onChange={(stages) => update({ stages })} />}
      {executor === 'rampingVus' && <>
        <Field label={t('flows.loadNode.scenario.startVus')}>
          {(id) => <Input id={id} type="number" min={0} step={1} value={String(asNonNegativeInteger(config.startVus, 0))} onChange={(event) => update({ startVus: asNonNegativeInteger(Number(event.target.value), 0) })} />}
        </Field>
        <Field label={t('flows.loadNode.scenario.gracefulRampDown')}>
          {(id) => <Input id={id} type="number" min={0} step={1} value={String(asNonNegativeInteger(config.gracefulRampDownMs, 0))} onChange={(event) => update({ gracefulRampDownMs: asNonNegativeInteger(Number(event.target.value), 0) })} />}
        </Field>
      </>}
      {(executor === 'constantArrivalRate' || executor === 'rampingArrivalRate') && <>
        <Field label={t('flows.loadNode.scenario.timeUnit')}>
          {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.timeUnitMs, 1000))} onChange={(event) => update({ timeUnitMs: asPositiveInteger(Number(event.target.value), 1) })} />}
        </Field>
        <Field label={t('flows.loadNode.scenario.preAllocatedVus')}>
          {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.preAllocatedVus, 1))} onChange={(event) => update({ preAllocatedVus: asPositiveInteger(Number(event.target.value), 1) })} />}
        </Field>
        <Field label={t('flows.loadNode.scenario.maxVus')} hint={t('flows.loadNode.scenario.maxVusHint')}>
          {(id) => <Input id={id} type="number" min={1} step={1} value={config.maxVus === undefined ? '' : String(asPositiveInteger(config.maxVus, 1))} onChange={(event) => onChange(event.target.value === '' ? withoutKeys(config, ['maxVus']) : { ...config, maxVus: asPositiveInteger(Number(event.target.value), 1) })} />}
        </Field>
      </>}
      {executor === 'constantArrivalRate' && <Field label={t('flows.loadNode.scenario.rate')}>
        {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.rate, 1))} onChange={(event) => update({ rate: asPositiveInteger(Number(event.target.value), 1) })} />}
      </Field>}
      {executor === 'rampingArrivalRate' && <Field label={t('flows.loadNode.scenario.startRate')}>
        {(id) => <Input id={id} type="number" min={1} step={1} value={String(asPositiveInteger(config.startRate, 1))} onChange={(event) => update({ startRate: asPositiveInteger(Number(event.target.value), 1) })} />}
      </Field>}
    </div>
  )
}

function RepeatLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <Field label={t('flows.loadNode.repeat.count')} hint={t('flows.loadNode.repeat.countHint')}>
      {(id) => <Input
        id={id}
        type="number"
        min={0}
        step={1}
        value={String(asNonNegativeInteger(config.count, 1))}
        onChange={(event) => onChange({ ...config, count: asNonNegativeInteger(Number(event.target.value), 0) })}
      />}
    </Field>
  )
}

function TimeBoxLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <Field label={t('flows.loadNode.timeBox.duration')} hint={t('flows.loadNode.timeBox.durationHint')}>
      {(id) => <Input
        id={id}
        type="number"
        min={1}
        step={1}
        value={String(asPositiveInteger(config.durationMs, 1000))}
        onChange={(event) => onChange({ ...config, durationMs: asPositiveInteger(Number(event.target.value), 1) })}
      />}
    </Field>
  )
}

type TimerKind = 'fixed' | 'uniform' | 'gaussian' | 'poisson' | 'pacing'

function timerKind(value: unknown): TimerKind {
  switch (value) {
    case 'uniform':
    case 'gaussian':
    case 'poisson':
    case 'pacing':
      return value
    default:
      return 'fixed'
  }
}

function TimerLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  const kind = timerKind(config.kind)
  const changeKind = (next: TimerKind) => {
    switch (next) {
      case 'uniform':
        onChange({ kind: next, minDurationMs: 500, maxDurationMs: 1000 })
        return
      case 'gaussian':
        onChange({ kind: next, meanMs: 1000, standardDeviationMs: 100 })
        return
      case 'poisson':
        onChange({ kind: next, meanMs: 1000 })
        return
      case 'pacing':
        onChange({ kind: next, periodMs: 1000 })
        return
      case 'fixed':
        onChange({ kind: next, durationMs: 1000 })
    }
  }
  const update = (changes: LoadConfig) => onChange({ ...config, ...changes })

  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.timer.kind')}>
        {(id) => <Select id={id} value={kind} onChange={(event) => changeKind(timerKind(event.target.value))}>
          <option value="fixed">{t('flows.loadNode.timer.fixed')}</option>
          <option value="uniform">{t('flows.loadNode.timer.uniform')}</option>
          <option value="gaussian">{t('flows.loadNode.timer.gaussian')}</option>
          <option value="poisson">{t('flows.loadNode.timer.poisson')}</option>
          <option value="pacing">{t('flows.loadNode.timer.pacing')}</option>
        </Select>}
      </Field>
      {kind === 'fixed' && <TimerDurationField label={t('flows.loadNode.timer.duration')} value={asNonNegativeInteger(config.durationMs, 1000)} onChange={(durationMs) => update({ durationMs })} />}
      {kind === 'uniform' && <>
        <TimerDurationField label={t('flows.loadNode.timer.minDuration')} value={asNonNegativeInteger(config.minDurationMs, 500)} onChange={(minDurationMs) => update({ minDurationMs })} />
        <TimerDurationField label={t('flows.loadNode.timer.maxDuration')} value={asNonNegativeInteger(config.maxDurationMs, 1000)} onChange={(maxDurationMs) => update({ maxDurationMs })} />
      </>}
      {kind === 'gaussian' && <>
        <TimerDurationField label={t('flows.loadNode.timer.mean')} value={asNonNegativeInteger(config.meanMs, 1000)} onChange={(meanMs) => update({ meanMs })} />
        <TimerDurationField label={t('flows.loadNode.timer.standardDeviation')} value={asNonNegativeInteger(config.standardDeviationMs, 100)} onChange={(standardDeviationMs) => update({ standardDeviationMs })} />
      </>}
      {kind === 'poisson' && <TimerDurationField label={t('flows.loadNode.timer.mean')} value={asNonNegativeInteger(config.meanMs, 1000)} onChange={(meanMs) => update({ meanMs })} />}
      {kind === 'pacing' && <TimerDurationField label={t('flows.loadNode.timer.period')} value={asNonNegativeInteger(config.periodMs, 1000)} onChange={(periodMs) => update({ periodMs })} />}
    </div>
  )
}

function TimerDurationField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      {(id) => <Input id={id} type="number" min={0} step={1} value={String(value)} onChange={(event) => onChange(asNonNegativeInteger(Number(event.target.value), 0))} />}
    </Field>
  )
}

function CheckLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.check.name')}>
        {(id) => <Input id={id} value={asString(config.name, 'status is 200')} onChange={(event) => onChange({ ...config, name: event.target.value })} />}
      </Field>
      <Field label={t('flows.loadNode.check.status')}>
        {(id) => <Input
          id={id}
          type="number"
          min={100}
          max={599}
          step={1}
          value={String(asHttpStatus(config.status, 200))}
          onChange={(event) => onChange({ ...config, status: asHttpStatus(Number(event.target.value), 100) })}
        />}
      </Field>
    </div>
  )
}

type ExtractKind = 'jsonPointer' | 'regex' | 'xpath' | 'css'

function extractKind(value: unknown): ExtractKind {
  switch (value) {
    case 'regex':
    case 'xpath':
    case 'css':
      return value
    default:
      return 'jsonPointer'
  }
}

function ExtractLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  const kind = extractKind(config.kind)
  const changeKind = (next: ExtractKind) => {
    switch (next) {
      case 'regex':
        onChange({ name: asString(config.name, 'value'), kind: next, pattern: '(.+)', group: 1 })
        return
      case 'xpath':
        onChange({ name: asString(config.name, 'value'), kind: next, expression: '//value/text()' })
        return
      case 'css':
        onChange({ name: asString(config.name, 'value'), kind: next, selector: 'body' })
        return
      case 'jsonPointer':
        onChange({ name: asString(config.name, 'value'), kind: next, jsonPointer: '' })
    }
  }
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.extract.name')}>
        {(id) => <Input id={id} mono value={asString(config.name, 'value')} onChange={(event) => onChange({ ...config, name: event.target.value })} />}
      </Field>
      <Field label={t('flows.loadNode.extract.kind')}>
        {(id) => <Select id={id} value={kind} onChange={(event) => changeKind(extractKind(event.target.value))}>
          <option value="jsonPointer">{t('flows.loadNode.extract.jsonPointer')}</option>
          <option value="regex">{t('flows.loadNode.extract.regex')}</option>
          <option value="xpath">{t('flows.loadNode.extract.xpath')}</option>
          <option value="css">{t('flows.loadNode.extract.css')}</option>
        </Select>}
      </Field>
      {kind === 'jsonPointer' && <Field label={t('flows.loadNode.extract.jsonPointer')} hint={t('flows.loadNode.extract.jsonPointerHint')}>
        {(id) => <Input id={id} mono value={asString(config.jsonPointer, '')} onChange={(event) => onChange({ ...config, jsonPointer: event.target.value })} />}
      </Field>}
      {kind === 'regex' && <>
        <Field label={t('flows.loadNode.extract.pattern')}>
          {(id) => <Input id={id} mono value={asString(config.pattern, '(.+)')} onChange={(event) => onChange({ ...config, pattern: event.target.value })} />}
        </Field>
        <Field label={t('flows.loadNode.extract.group')} hint={t('flows.loadNode.extract.groupHint')}>
          {(id) => <Input id={id} type="number" min={0} step={1} value={String(asNonNegativeInteger(config.group, 1))} onChange={(event) => onChange({ ...config, group: asNonNegativeInteger(Number(event.target.value), 0) })} />}
        </Field>
      </>}
      {kind === 'xpath' && <Field label={t('flows.loadNode.extract.expression')}>
        {(id) => <Input id={id} mono value={asString(config.expression, '//value/text()')} onChange={(event) => onChange({ ...config, expression: event.target.value })} />}
      </Field>}
      {kind === 'css' && <>
        <Field label={t('flows.loadNode.extract.selector')}>
          {(id) => <Input id={id} mono value={asString(config.selector, 'body')} onChange={(event) => onChange({ ...config, selector: event.target.value })} />}
        </Field>
        <Field label={t('flows.loadNode.extract.attribute')} hint={t('flows.loadNode.extract.attributeHint')}>
          {(id) => <Input id={id} mono value={asString(config.attribute, '')} onChange={(event) => onChange(event.target.value === '' ? withoutKeys(config, ['attribute']) : { ...config, attribute: event.target.value })} />}
        </Field>
      </>}
    </div>
  )
}

function ScriptLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  const phase = asString(config.phase, 'preRequest')
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.script.phase')}>
        {(id) => <Select id={id} value={phase} onChange={(event) => onChange({ ...config, phase: event.target.value })}>
          <option value="preRequest">{t('flows.loadNode.script.preRequest')}</option>
          <option value="postResponse">{t('flows.loadNode.script.postResponse')}</option>
        </Select>}
      </Field>
      <Field label={t('flows.loadNode.script.code')}>
        {(id) => <Textarea id={id} mono rows={8} value={asString(config.code, '')} spellCheck={false} onChange={(event) => onChange({ ...config, code: event.target.value })} />}
      </Field>
    </div>
  )
}

function GroupLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.group.name')}>
        {(id) => <Input id={id} value={asString(config.name, 'group')} onChange={(event) => onChange({ ...config, name: event.target.value })} />}
      </Field>
      <TagsLoadField tags={config.tags} onChange={(tags) => onChange({ ...config, tags })} />
      <label className="flow-inspector-checkbox-row">
        <Checkbox
          checked={config.includeTimers !== false}
          onChange={(event) => onChange({ ...config, includeTimers: event.target.checked })}
        />
        {t('flows.loadNode.group.includeTimers')}
      </label>
      <label className="flow-inspector-checkbox-row">
        <Checkbox
          checked={config.emitParent !== false}
          onChange={(event) => onChange({ ...config, emitParent: event.target.checked })}
        />
        {t('flows.loadNode.group.emitParent')}
      </label>
    </div>
  )
}

function MetricLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.metric.name')}>
        {(id) => <Input id={id} mono value={asString(config.name, 'events')} onChange={(event) => onChange({ ...config, name: event.target.value })} />}
      </Field>
      <Field label={t('flows.loadNode.metric.kind')}>
        {(id) => <Select id={id} value={asString(config.kind, 'counter')} onChange={(event) => onChange({ ...config, kind: event.target.value })}>
          <option value="counter">Counter</option>
          <option value="gauge">Gauge</option>
          <option value="rate">Rate</option>
          <option value="trend">Trend</option>
        </Select>}
      </Field>
      <Field label={t('flows.loadNode.metric.value')}>
        {(id) => <Input
          id={id}
          type="number"
          step="any"
          value={String(asFiniteNumber(config.value, 1))}
          onChange={(event) => onChange({ ...config, value: asFiniteNumber(Number(event.target.value), 0) })}
        />}
      </Field>
      <TagsLoadField tags={config.tags} onChange={(tags) => onChange({ ...config, tags })} />
    </div>
  )
}

function ThresholdLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.threshold.metric')}>
        {(id) => <Input id={id} mono value={asString(config.metric, 'http_req_failed')} onChange={(event) => onChange({ ...config, metric: event.target.value })} />}
      </Field>
      <TagsLoadField tags={config.tags} onChange={(tags) => onChange({ ...config, tags })} />
      <Field label={t('flows.loadNode.threshold.statistic')}>
        {(id) => <Select id={id} value={asString(config.statistic, 'value')} onChange={(event) => onChange({ ...config, statistic: event.target.value })}>
          <option value="count">Count</option>
          <option value="value">Value</option>
          <option value="rate">Rate</option>
          <option value="avg">Average</option>
          <option value="min">Minimum</option>
          <option value="max">Maximum</option>
          <option value="p90">P90</option>
          <option value="p95">P95</option>
          <option value="p99">P99</option>
        </Select>}
      </Field>
      <Field label={t('flows.loadNode.threshold.comparison')}>
        {(id) => <Select id={id} value={asString(config.comparison, 'lt')} onChange={(event) => onChange({ ...config, comparison: event.target.value })}>
          <option value="lt">&lt;</option>
          <option value="lte">≤</option>
          <option value="gt">&gt;</option>
          <option value="gte">≥</option>
          <option value="eq">=</option>
          <option value="ne">≠</option>
        </Select>}
      </Field>
      <Field label={t('flows.loadNode.threshold.target')}>
        {(id) => <Input
          id={id}
          type="number"
          step="any"
          value={String(asFiniteNumber(config.target, 0))}
          onChange={(event) => onChange({ ...config, target: asFiniteNumber(Number(event.target.value), 0) })}
        />}
      </Field>
    </div>
  )
}

function ForEachLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  const items = Array.isArray(config.items) && config.items.every((item) => typeof item === 'string')
    ? config.items as string[]
    : ['value']
  const isDynamic = typeof config.itemsVariable === 'string'
  const update = (changes: LoadConfig) => onChange({ ...config, ...changes })

  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.forEach.variable')}>
        {(id) => <Input id={id} mono value={asString(config.variable, 'item')} onChange={(event) => update({ variable: event.target.value })} />}
      </Field>
      <Field label={t('flows.loadNode.forEach.source')}>
        {(id) => <Select
          id={id}
          value={isDynamic ? 'variable' : 'literal'}
          onChange={(event) => {
            if (event.target.value === 'variable') {
              onChange(withoutKeys({ ...config, itemsVariable: asString(config.itemsVariable, 'items'), maxItems: asPositiveInteger(config.maxItems, 1) }, ['items']))
            } else {
              onChange(withoutKeys({ ...config, items }, ['itemsVariable', 'maxItems']))
            }
          }}
        >
          <option value="literal">{t('flows.loadNode.forEach.sourceLiteral')}</option>
          <option value="variable">{t('flows.loadNode.forEach.sourceVariable')}</option>
        </Select>}
      </Field>
      {isDynamic ? (
        <>
          <Field label={t('flows.loadNode.forEach.itemsVariable')} hint={t('flows.loadNode.forEach.itemsVariableHint')}>
            {(id) => <Input id={id} mono value={asString(config.itemsVariable, 'items')} onChange={(event) => update({ itemsVariable: event.target.value })} />}
          </Field>
          <Field label={t('flows.loadNode.forEach.maxItems')}>
            {(id) => <Input
              id={id}
              type="number"
              min={1}
              step={1}
              value={String(asPositiveInteger(config.maxItems, 1))}
              onChange={(event) => update({ maxItems: asPositiveInteger(Number(event.target.value), 1) })}
            />}
          </Field>
        </>
      ) : (
        <Field label={t('flows.loadNode.forEach.items')} hint={t('flows.loadNode.forEach.itemsHint')}>
          {(id) => <Textarea
            id={id}
            mono
            rows={5}
            value={items.join('\n')}
            onChange={(event) => update({ items: event.target.value.split('\n') })}
          />}
        </Field>
      )}
    </div>
  )
}

function SelectLoadFields({ config, onChange }: { config: LoadConfig; onChange: (config: LoadConfig) => void }) {
  const { t } = useLanguage()
  const operator = asString(config.operator, 'equals')
  const comparesValue = operator === 'equals' || operator === 'notEquals'
  const update = (changes: LoadConfig) => onChange({ ...config, ...changes })

  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.loadNode.select.variable')}>
        {(id) => <Input id={id} mono value={asString(config.variable, 'item')} onChange={(event) => update({ variable: event.target.value })} />}
      </Field>
      <Field label={t('flows.loadNode.select.operator')}>
        {(id) => <Select
          id={id}
          value={operator}
          onChange={(event) => {
            const next = event.target.value
            onChange(
              (next === 'equals' || next === 'notEquals')
                ? { ...config, operator: next, equals: asString(config.equals, 'value') }
                : withoutKeys({ ...config, operator: next }, ['equals']),
            )
          }}
        >
          <option value="equals">{t('flows.loadNode.select.equals')}</option>
          <option value="notEquals">{t('flows.loadNode.select.notEquals')}</option>
          <option value="exists">{t('flows.loadNode.select.exists')}</option>
          <option value="notExists">{t('flows.loadNode.select.notExists')}</option>
        </Select>}
      </Field>
      {comparesValue && (
        <Field label={t('flows.loadNode.select.equalsValue')}>
          {(id) => <Input id={id} mono value={asString(config.equals, 'value')} onChange={(event) => update({ equals: event.target.value })} />}
        </Field>
      )}
    </div>
  )
}

interface ConditionFieldsProps {
  condition: ConditionState
  onChange: (condition: ConditionState) => void
}

/** Formulário da condição de um node `if` — `left`/`right` reaproveitam o
 * mesmo campo de texto livre que já serve pra colar uma referência
 * `{{nodes.<id>...}}` copiada de `VariablesSection` logo abaixo (mesmo
 * padrão de campo simples, sem autocomplete rico de path JSON). */
function ConditionFields({ condition, onChange }: ConditionFieldsProps) {
  const { t } = useLanguage()

  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.canvas.conditionLeftLabel')}>
        <Input
          mono
          value={condition.left}
          placeholder={t('flows.canvas.conditionLeftPlaceholder')}
          onChange={(event) => onChange({ ...condition, left: event.target.value })}
        />
      </Field>
      <Field label={t('flows.canvas.conditionOperatorLabel')}>
        <Select
          value={condition.operator}
          onChange={(event) => onChange({ ...condition, operator: event.target.value as ComparisonOperatorState })}
        >
          {OPERATOR_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('flows.canvas.conditionRightLabel')}>
        <Input
          mono
          value={condition.right}
          placeholder={t('flows.canvas.conditionRightPlaceholder')}
          onChange={(event) => onChange({ ...condition, right: event.target.value })}
        />
      </Field>
    </div>
  )
}

/** O backend exige nome não vazio: um campo apagado não é gravado até ter
 * texto de novo. */
function InlineRequestNameField({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  const { t } = useLanguage()
  const [draft, setDraft] = useState(name)
  return (
    <Field label={t('flows.canvas.inspectorInlineRequestNameLabel')}>
      <Input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          if (event.target.value.trim()) onChange(event.target.value)
        }}
      />
    </Field>
  )
}

type SleepUnit = 'ms' | 's'

/** Duração do `sleep`, guardada sempre em ms; a unidade é só de exibição. O
 * campo numérico não é controlado (`defaultValue` + `key` da unidade) para
 * aceitar estados intermediários de digitação como "1." sem perdê-los. */
function SleepFields({ durationMs, onChange }: { durationMs: number; onChange: (durationMs: number) => void }) {
  const { t } = useLanguage()
  const [unit, setUnit] = useState<SleepUnit>(durationMs >= 1000 && durationMs % 1000 === 0 ? 's' : 'ms')
  const factor = unit === 's' ? 1000 : 1

  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.canvas.sleepDurationLabel')} hint={t('flows.canvas.sleepLimitHint')}>
        <Input
          key={unit}
          type="number"
          min={0}
          max={MAX_SLEEP_MS / factor}
          step={unit === 's' ? 0.1 : 100}
          defaultValue={String(durationMs / factor)}
          onChange={(event) => {
            const value = Number.parseFloat(event.target.value)
            if (Number.isNaN(value)) return
            onChange(Math.min(MAX_SLEEP_MS, Math.max(0, Math.round(value * factor))))
          }}
        />
      </Field>
      <Field label={t('flows.canvas.sleepUnitLabel')}>
        <Select value={unit} onChange={(event) => setUnit(event.target.value as SleepUnit)}>
          <option value="ms">{t('flows.canvas.sleepUnitMilliseconds')}</option>
          <option value="s">{t('flows.canvas.sleepUnitSeconds')}</option>
        </Select>
      </Field>
    </div>
  )
}

/** Lista editável das atribuições de um node `setVariables`. */
function AssignmentFields({
  assignments,
  onChange,
}: {
  assignments: VariableAssignmentState[]
  onChange: (assignments: VariableAssignmentState[]) => void
}) {
  const { t } = useLanguage()
  const update = (index: number, assignment: VariableAssignmentState) =>
    onChange(assignments.map((current, currentIndex) => (currentIndex === index ? assignment : current)))

  return (
    <div className="flow-inspector-assignments">
      <p className="flow-inspector-hint">{t('flows.canvas.setVariablesHint')}</p>
      {assignments.length === 0 && <p className="flow-inspector-hint">{t('flows.canvas.setVariablesEmpty')}</p>}
      {assignments.map((assignment, index) => (
        <div key={index} className="flow-inspector-assignment">
          <div className="flow-inspector-assignment-header">
            <Input
              mono
              value={assignment.name}
              placeholder={t('flows.canvas.setVariablesNameLabel')}
              aria-label={t('flows.canvas.setVariablesNameLabel')}
              onChange={(event) => update(index, { ...assignment, name: event.target.value })}
            />
            <IconButton
              icon={<TrashIcon size={12} />}
              label={t('flows.canvas.setVariablesRemoveAria', { name: assignment.name })}
              size="sm"
              onClick={() => onChange(assignments.filter((_, currentIndex) => currentIndex !== index))}
            />
          </div>
          <Select
            aria-label={t('flows.canvas.setVariablesOperationLabel')}
            value={assignment.operation}
            onChange={(event) =>
              update(
                index,
                event.target.value === 'increment'
                  ? { name: assignment.name, operation: 'increment', by: 1 }
                  : { name: assignment.name, operation: 'set', value: '' },
              )
            }
          >
            <option value="set">{t('flows.canvas.setVariablesOperationSet')}</option>
            <option value="increment">{t('flows.canvas.setVariablesOperationIncrement')}</option>
          </Select>
          {assignment.operation === 'set' ? (
            <Input
              mono
              value={assignment.value}
              placeholder={t('flows.canvas.setVariablesValueLabel')}
              aria-label={t('flows.canvas.setVariablesValueLabel')}
              onChange={(event) => update(index, { ...assignment, value: event.target.value })}
            />
          ) : (
            <Input
              key={`increment-${index}`}
              type="number"
              step="any"
              defaultValue={String(assignment.by)}
              aria-label={t('flows.canvas.setVariablesByLabel')}
              onChange={(event) => {
                const by = Number.parseFloat(event.target.value)
                if (!Number.isNaN(by)) update(index, { ...assignment, by })
              }}
            />
          )}
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...assignments, { name: '', operation: 'set', value: '' }])}>
        <PlusIcon size={12} />
        {t('flows.canvas.setVariablesAddButton')}
      </Button>
    </div>
  )
}

interface VariablesSectionProps {
  ancestorRequests: AncestorRequestRef[]
  localVariables: string[]
  environmentVariables: EnvironmentVariableDto[]
}

interface VariableEntry {
  reference: string
  description: string
}

function VariablesSection({ ancestorRequests, localVariables, environmentVariables }: VariablesSectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [query, setQuery] = useState('')

  const environmentEntries = useMemo<VariableEntry[]>(
    () =>
      environmentVariables.map((variable) => ({
        reference: `{{${variable.name}}}`,
        description: describeVariable(t, variable.name, environmentVariables),
      })),
    [environmentVariables, t],
  )

  const nodeEntries = useMemo<VariableEntry[]>(
    () =>
      ancestorRequests.flatMap((ancestor): VariableEntry[] => {
        if (ancestor.output === 'mockServer') {
          return [
            {
              reference: `{{nodes.${ancestor.nodeId}.server.url}}`,
              description: `${ancestor.label} — ${t('flows.canvas.variableReferenceMockUrlLabel')}`,
            },
          ]
        }
        if (ancestor.output === 'mockRequest') {
          return [
            {
              reference: `{{nodes.${ancestor.nodeId}.request.body}}`,
              description: `${ancestor.label} — ${t('flows.canvas.variableReferenceMockBodyLabel')}`,
            },
            {
              reference: `{{nodes.${ancestor.nodeId}.request.method}}`,
              description: `${ancestor.label} — ${t('flows.canvas.variableReferenceMockMethodLabel')}`,
            },
          ]
        }
        return [
          {
            reference: `{{nodes.${ancestor.nodeId}.response.status}}`,
            description: `${ancestor.label} — ${t('flows.canvas.variableReferenceStatusLabel')}`,
          },
          {
            reference: `{{nodes.${ancestor.nodeId}.response.body}}`,
            description: `${ancestor.label} — ${t('flows.canvas.variableReferenceBodyLabel')}`,
          },
        ]
      }),
    [ancestorRequests, t],
  )

  const localEntries = useMemo<VariableEntry[]>(
    () => localVariables.map((name) => ({ reference: `{{${name}}}`, description: t('flows.canvas.variableLocalDescription') })),
    [localVariables, t],
  )

  const needle = query.trim().toLowerCase()
  const matches = (entry: VariableEntry) =>
    !needle || entry.reference.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle)

  const filteredNodes = nodeEntries.filter(matches)
  const filteredLocal = localEntries.filter(matches)
  const filteredEnvironment = environmentEntries.filter(matches)

  const copyReference = async (reference: string) => {
    try {
      await navigator.clipboard.writeText(reference)
      showToast(t('toasts.nodeReferenceCopied'))
    } catch {
      // Clipboard indisponível — sem toast de sucesso.
    }
  }

  return (
    <div className="flow-inspector-variables">
      <p className="flow-inspector-section-title">{t('flows.canvas.variablesSectionTitle')}</p>
      <div className="flow-inspector-variables-search">
        <SearchIcon size={11} />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('flows.canvas.variablesSearchPlaceholder')}
          aria-label={t('flows.canvas.variablesSearchAria')}
        />
      </div>

      {filteredNodes.length > 0 && (
        <div className="flow-inspector-variables-group">
          <p className="flow-inspector-variables-group-label">{t('flows.canvas.variablesNodesGroup')}</p>
          {filteredNodes.map((entry) => (
            <button
              key={entry.reference}
              type="button"
              className="flow-inspector-variable-row"
              onClick={() => void copyReference(entry.reference)}
              aria-label={t('flows.canvas.copyVariableAria', { reference: entry.reference })}
            >
              <span className="flow-inspector-variable-reference">{entry.reference}</span>
              <span className="flow-inspector-variable-description">{entry.description}</span>
            </button>
          ))}
        </div>
      )}

      {filteredLocal.length > 0 && (
        <div className="flow-inspector-variables-group">
          <p className="flow-inspector-variables-group-label">{t('flows.canvas.variablesLocalGroup')}</p>
          {filteredLocal.map((entry) => (
            <button
              key={entry.reference}
              type="button"
              className="flow-inspector-variable-row"
              onClick={() => void copyReference(entry.reference)}
              aria-label={t('flows.canvas.copyVariableAria', { reference: entry.reference })}
            >
              <span className="flow-inspector-variable-reference">{entry.reference}</span>
              <span className="flow-inspector-variable-description">{entry.description}</span>
            </button>
          ))}
        </div>
      )}

      {filteredEnvironment.length > 0 && (
        <div className="flow-inspector-variables-group">
          <p className="flow-inspector-variables-group-label">{t('flows.canvas.variablesEnvironmentGroup')}</p>
          {filteredEnvironment.map((entry) => (
            <button
              key={entry.reference}
              type="button"
              className="flow-inspector-variable-row"
              onClick={() => void copyReference(entry.reference)}
              aria-label={t('flows.canvas.copyVariableAria', { reference: entry.reference })}
            >
              <span className="flow-inspector-variable-reference">{entry.reference}</span>
              <span className="flow-inspector-variable-description">{entry.description}</span>
            </button>
          ))}
        </div>
      )}

      {filteredEnvironment.length === 0 && filteredNodes.length === 0 && filteredLocal.length === 0 && (
        <p className="flow-inspector-variables-empty">{t('flows.canvas.variablesEmptyState')}</p>
      )}
    </div>
  )
}
