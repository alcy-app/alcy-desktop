import { useState } from 'react'
import type { MockServerSummaryDto } from '../../bindings/mock-servers'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { newMockServer } from '../mock-servers/mock-server-defaults'
import type { MockCallCountOperatorState, SimpleNodeKindState } from './flows.types'
import { findMockRoute, mockRouteLabel, mockRouteResponses } from './mock-nodes'
import type { MockStartInfo } from './mock-nodes'

/** Maior espera aceita pelo motor (`MAX_SLEEP_MS` em `execute_flow.rs`). */
const MAX_WAIT_MS = 10 * 60 * 1000
const DEFAULT_INLINE_MOCK_PORT = 3001

type MockConfig = Extract<SimpleNodeKindState, { kind: 'mockStart' | 'mockStop' | 'mockWaitRequest' | 'mockSetResponse' | 'mockAssertCalls' }>

interface MockNodeFieldsProps {
  nodeId: string
  config: MockConfig
  /** Blocos "Ligar mock" ancestrais — os que este bloco pode usar. */
  startOptions: MockStartInfo[]
  /** O mock deste bloco: o próprio (Ligar) ou o do bloco escolhido. */
  start: MockStartInfo | null
  savedServers: MockServerSummaryDto[]
  onChange: (config: MockConfig) => void
  onEditInlineMockServer: (nodeId: string) => void
}

/** Configuração dos blocos de mock no inspector (spec 0121). */
export function MockNodeFields({ nodeId, config, startOptions, start, savedServers, onChange, onEditInlineMockServer }: MockNodeFieldsProps) {
  if (config.kind === 'mockStart') {
    return (
      <MockStartFields
        nodeId={nodeId}
        config={config}
        start={start}
        savedServers={savedServers}
        onChange={onChange}
        onEditInlineMockServer={onEditInlineMockServer}
      />
    )
  }
  return <MockTargetFields key={nodeId} config={config} startOptions={startOptions} start={start} onChange={onChange} />
}

function MockStartFields({
  nodeId,
  config,
  start,
  savedServers,
  onChange,
  onEditInlineMockServer,
}: Omit<MockNodeFieldsProps, 'config' | 'startOptions'> & { config: Extract<MockConfig, { kind: 'mockStart' }> }) {
  const { t } = useLanguage()
  const { source } = config

  const changeSourceType = (type: 'saved' | 'inline') => {
    if (type === source.type) return
    if (type === 'saved') {
      onChange({ kind: 'mockStart', source: { type: 'saved', serverId: '' } })
      return
    }
    // Avulso a partir do salvo escolhido, quando houver: mesmas rotas, id próprio.
    const base = start?.server
    const server = base ? { ...structuredClone(base), id: crypto.randomUUID() } : newMockServer(DEFAULT_INLINE_MOCK_PORT, t)
    if (!base) server.name = t('flows.canvas.mockInlineDefaultName')
    onChange({ kind: 'mockStart', source: { type: 'inline', server } })
  }

  return (
    <>
      <Field label={t('flows.canvas.mockSourceLabel')}>
        <Select value={source.type} onChange={(event) => changeSourceType(event.target.value as 'saved' | 'inline')}>
          <option value="saved">{t('flows.canvas.mockSourceSaved')}</option>
          <option value="inline">{t('flows.canvas.mockSourceInline')}</option>
        </Select>
      </Field>

      {source.type === 'saved' ? (
        <>
          <Field label={t('flows.canvas.mockServerLabel')} hint={t('flows.canvas.mockSavedHint')}>
            <Select
              value={source.serverId}
              onChange={(event) => onChange({ kind: 'mockStart', source: { type: 'saved', serverId: event.target.value } })}
            >
              <option value="">{t('flows.canvas.mockNoServerSelected')}</option>
              {source.serverId && !savedServers.some((server) => server.id === source.serverId) && (
                <option value={source.serverId}>{t('flows.canvas.mockServerMissing')}</option>
              )}
              {savedServers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} · {server.port}
                </option>
              ))}
            </Select>
          </Field>
          {savedServers.length === 0 && <p className="flow-inspector-hint">{t('flows.canvas.mockNoSavedServers')}</p>}
        </>
      ) : (
        <>
          <p className="flow-inspector-hint">{t('flows.canvas.mockInlineHint')}</p>
          <InlineServerFields
            key={nodeId}
            name={source.server.name}
            port={source.server.port}
            onChange={(name, port) => onChange({ kind: 'mockStart', source: { type: 'inline', server: { ...source.server, name, port } } })}
          />
          <Button variant="ghost" size="sm" onClick={() => onEditInlineMockServer(nodeId)}>
            {t('flows.canvas.editInlineMockLabel')}
          </Button>
        </>
      )}

      <p className="flow-inspector-hint">
        {t('flows.canvas.mockServerUrlHint')} <code>{`{{nodes.${nodeId}.server.url}}`}</code>
      </p>
    </>
  )
}

/** Nome e porta do mock avulso. O backend exige nome não vazio e porta
 * válida: um valor inválido não é gravado até ser corrigido. */
function InlineServerFields({ name, port, onChange }: { name: string; port: number; onChange: (name: string, port: number) => void }) {
  const { t } = useLanguage()
  const [draftName, setDraftName] = useState(name)
  return (
    <div className="flow-inspector-condition">
      <Field label={t('flows.canvas.mockInlineNameLabel')}>
        <Input
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value)
            if (event.target.value.trim()) onChange(event.target.value, port)
          }}
        />
      </Field>
      <Field label={t('flows.canvas.mockInlinePortLabel')}>
        <Input
          type="number"
          min={1}
          max={65535}
          step={1}
          defaultValue={String(port)}
          onChange={(event) => {
            const value = Number.parseInt(event.target.value, 10)
            if (!Number.isNaN(value) && value >= 1 && value <= 65535) onChange(name, value)
          }}
        />
      </Field>
    </div>
  )
}

function MockTargetFields({
  config,
  startOptions,
  start,
  onChange,
}: {
  config: Exclude<MockConfig, { kind: 'mockStart' }>
  startOptions: MockStartInfo[]
  start: MockStartInfo | null
  onChange: (config: MockConfig) => void
}) {
  const { t } = useLanguage()
  const routes = start?.server?.routes ?? []
  const selectedIsOption = startOptions.some((option) => option.nodeId === config.startNodeId)

  return (
    <>
      <Field label={t('flows.canvas.mockStartNodeLabel')} hint={t('flows.canvas.mockStartNodeHint')}>
        <Select
          value={config.startNodeId}
          onChange={(event) => {
            const startNodeId = event.target.value
            onChange(config.kind === 'mockStop' ? { ...config, startNodeId } : { ...config, startNodeId, routeId: '' })
          }}
        >
          <option value="">{t('flows.canvas.mockNoStartSelected')}</option>
          {config.startNodeId && !selectedIsOption && (
            <option value={config.startNodeId}>{t('flows.canvas.mockStartNotAncestor')}</option>
          )}
          {startOptions.map((option) => (
            <option key={option.nodeId} value={option.nodeId}>
              {option.name || t('flows.canvas.mockUnnamedServer')} · #{option.nodeId.slice(0, 8)}
            </option>
          ))}
        </Select>
      </Field>
      {startOptions.length === 0 && <p className="flow-inspector-hint">{t('flows.canvas.mockNoStartAvailable')}</p>}

      {config.kind !== 'mockStop' && (
        <Field label={t('flows.canvas.mockRouteLabel')}>
          <Select
            value={config.routeId}
            disabled={!start?.server}
            onChange={(event) =>
              onChange(config.kind === 'mockSetResponse' ? { ...config, routeId: event.target.value, responseId: null } : { ...config, routeId: event.target.value })
            }
          >
            <option value="">{t('flows.canvas.mockNoRouteSelected')}</option>
            {config.routeId && !routes.some((route) => route.id === config.routeId) && (
              <option value={config.routeId}>{t('flows.canvas.mockRouteMissing')}</option>
            )}
            {routes.map((route) => (
              <option key={route.id} value={route.id}>
                {mockRouteLabel(route)} — {route.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {config.kind === 'mockWaitRequest' && (
        <Field label={t('flows.canvas.mockWaitTimeoutLabel')} hint={t('flows.canvas.mockWaitHint')}>
          <Input
            type="number"
            min={0.1}
            max={MAX_WAIT_MS / 1000}
            step={1}
            defaultValue={String(config.timeoutMs / 1000)}
            onChange={(event) => {
              const seconds = Number.parseFloat(event.target.value)
              if (Number.isNaN(seconds)) return
              onChange({ ...config, timeoutMs: Math.min(MAX_WAIT_MS, Math.max(100, Math.round(seconds * 1000))) })
            }}
          />
        </Field>
      )}

      {config.kind === 'mockSetResponse' && (
        <MockResponseField
          responses={(() => {
            const route = findMockRoute(start?.server ?? null, config.routeId)
            return route ? mockRouteResponses(route) : []
          })()}
          responseId={config.responseId}
          onChange={(responseId) => onChange({ ...config, responseId })}
        />
      )}

      {config.kind === 'mockAssertCalls' && (
        <div className="flow-inspector-condition">
          <Field label={t('flows.canvas.mockAssertOperatorLabel')}>
            <Select
              value={config.operator}
              onChange={(event) => onChange({ ...config, operator: event.target.value as MockCallCountOperatorState })}
            >
              <option value="equals">{t('flows.canvas.mockAssertEquals')}</option>
              <option value="atLeast">{t('flows.canvas.mockAssertAtLeast')}</option>
              <option value="atMost">{t('flows.canvas.mockAssertAtMost')}</option>
            </Select>
          </Field>
          <Field label={t('flows.canvas.mockAssertCountLabel')}>
            <Input
              type="number"
              min={0}
              step={1}
              defaultValue={String(config.count)}
              onChange={(event) => {
                const count = Number.parseInt(event.target.value, 10)
                if (!Number.isNaN(count) && count >= 0) onChange({ ...config, count })
              }}
            />
          </Field>
          <p className="flow-inspector-hint">{t('flows.canvas.mockAssertHint')}</p>
        </div>
      )}
    </>
  )
}

function MockResponseField({
  responses,
  responseId,
  onChange,
}: {
  responses: { id: string; name: string }[]
  responseId: string | null
  onChange: (responseId: string | null) => void
}) {
  const { t } = useLanguage()
  return (
    <Field label={t('flows.canvas.mockResponseLabel')} hint={t('flows.canvas.mockSetResponseHint')}>
      <Select value={responseId ?? ''} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">{t('flows.canvas.mockResponseRules')}</option>
        {responseId && !responses.some((response) => response.id === responseId) && (
          <option value={responseId}>{t('flows.canvas.mockResponseMissing')}</option>
        )}
        {responses.map((response) => (
          <option key={response.id} value={response.id}>
            {response.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}
