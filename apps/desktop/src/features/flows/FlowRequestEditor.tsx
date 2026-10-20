import { useState } from 'react'
import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { Input } from '../../shared/ui/Input'
import { Select } from '../../shared/ui/Select'
import { IconButton } from '../../shared/ui/IconButton'
import { Checkbox } from '../../shared/ui/Checkbox'
import { TrashIcon } from '../../shared/ui/icons'
import { toAuthenticationInput, toAuthorizationState } from '../request-workbench/authorization-state'
import { contentTypeFor, syncContentTypeHeader, toBodyState, toRestBodyInput } from '../request-workbench/body-state'
import type { RequestContent } from '../request-workbench/collection-tree'
import { AuthorizationPanel } from '../request-workbench/components/AuthorizationPanel'
import { GrpcSchemaSource } from '../request-workbench/components/GrpcSchemaSource'
import { HeadersPanel } from '../request-workbench/components/HeadersPanel'
import { RequestBodyPanel } from '../request-workbench/components/RequestBodyPanel'
import { QueryPanel } from '../request-workbench/components/QueryPanel'
import { buildUrlWithParams, parseQueryParams } from '../request-workbench/query-params'
import { RestBodyPanel } from '../request-workbench/components/RestBodyPanel'
import { TemplateHighlightedField } from '../request-workbench/components/TemplateHighlightedField'
import type { BodyState } from '../request-workbench/request-workbench.types'
import { FlowTabs } from './FlowTabs'
import { useFlowMapping } from './flow-reference'

interface Props {
  content: RequestContent
  rootPath: string
  variables: EnvironmentVariableDto[]
  targetLabel: string
  dirty: boolean
  busy?: boolean
  onChange: (content: RequestContent) => void
  onSave: () => Promise<void>
  onDiscard: () => void
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

export function FlowRequestEditor({ content, rootPath, variables: environmentVariables, targetLabel, dirty, busy = false, onChange, onSave, onDiscard }: Props) {
  const { t } = useLanguage()
  const { references } = useFlowMapping()
  const roots = references.map((reference) => reference.slice(2, -2))
  const templateNames = [...JSON.stringify(content).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim())
  const known = [...new Set([...roots, ...templateNames.filter((name) => roots.some((root) => name === root || name.startsWith(`${root}.`)))])]
  const variables = [...environmentVariables, ...known.filter((name) => !environmentVariables.some((variable) => variable.name === name)).map((name) => ({ name, value: t('flows.studio.unresolved'), sensitive: false }))]
  const [tab, setTab] = useState<'body' | 'headers' | 'params' | 'auth' | 'scripts'>('body')
  const [body, setBody] = useState(() => toBodyState(content.body))
  const [bodySource, setBodySource] = useState(content.body)
  const [params, setParams] = useState(() => parseQueryParams(content.endpointUrl).map((param) => ({ ...param, id: crypto.randomUUID(), enabled: true })))
  const [paramsSource, setParamsSource] = useState(content.endpointUrl)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Consume each incoming change once; a serialized round trip may differ in property order or omit unnamed query parameters.
  if (bodySource !== content.body) {
    setBodySource(content.body)
    const next = toBodyState(content.body)
    if (JSON.stringify(toRestBodyInput(body)) !== JSON.stringify(toRestBodyInput(next))) setBody(next)
  }
  if (paramsSource !== content.endpointUrl) {
    setParamsSource(content.endpointUrl)
    const next = parseQueryParams(content.endpointUrl)
    if (JSON.stringify(params.filter((param) => param.enabled && param.name).map(({ name, value }) => ({ name, value }))) !== JSON.stringify(next)) {
      setParams(next.map((param) => ({ ...param, id: crypto.randomUUID(), enabled: true })))
    }
  }
  const patch = (changes: Partial<RequestContent>) => onChange({ ...content, ...changes })
  const updateBody = (changes: Partial<BodyState>) => {
    const next = { ...body, ...changes }
    setBody(next)
    const headers = changes.type !== undefined || changes.rawLanguage !== undefined
      ? syncContentTypeHeader(content.headers.map((header, index) => ({ ...header, id: String(index) })), contentTypeFor(next.type, next.rawLanguage), () => crypto.randomUUID()).map(({ name, value, enabled }) => ({ name, value, enabled }))
      : content.headers
    patch({ body: toRestBodyInput(next), headers })
  }
  const updateParams = (next: typeof params) => { setParams(next); patch({ endpointUrl: buildUrlWithParams(content.endpointUrl, next) }) }
  const save = async () => { setSaving(true); setError(''); try { await onSave() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setSaving(false) } }
  const updateGrpc = (changes: Partial<RequestContent['grpc']>) => patch({ grpc: { ...content.grpc, ...changes } })

  return <section className="flow-request-editor" aria-label={t('flows.studio.requestEditor')}>
    <div className="flow-request-destination"><span>{targetLabel}</span>{dirty && <span className="flow-request-dirty">● {t('flows.studio.unsaved')}</span>}</div>
    <div className="flow-request-endpoint">
      {content.protocol === 'rest' ? <Select aria-label={t('flows.studio.method')} value={content.method} onChange={(event) => patch({ method: event.target.value as RequestContent['method'] })}>{METHODS.map((method) => <option key={method} value={method}>{method.toUpperCase()}</option>)}</Select> : <span className="flow-request-protocol">{content.protocol === 'grpc' ? 'gRPC' : 'GraphQL'}</span>}
      <label className="rw-visually-hidden" htmlFor="flow-request-url">{t('endpointBar.endpointLabel')}</label><TemplateHighlightedField id="flow-request-url" fieldClassName="ui-input ui-input--mono" value={content.endpointUrl} onChange={(endpointUrl) => patch({ endpointUrl })} variables={variables} placeholder={t('endpointBar.endpointLabel')} />
    </div>
    <FlowTabs className="flow-request-tabs" items={(['body', 'headers', 'params', 'auth', 'scripts'] as const).map((id) => ({ id, label: `${t(`flows.studio.${id}`)}${id === 'headers' && content.headers.length > 0 ? ` (${content.headers.length})` : ''}` }))} value={tab} onChange={setTab} label={t('flows.studio.request')} />
    <div className="flow-request-section" role="tabpanel">
      {tab === 'body' && (content.protocol === 'rest' ? <RestBodyPanel body={body} rootPath={rootPath} environmentVariables={variables}
        onTypeChange={(type) => updateBody({ type })} onRawLanguageChange={(rawLanguage) => updateBody({ rawLanguage })} onRawChange={(raw) => updateBody({ raw })}
        onAddUrlEncoded={() => updateBody({ urlEncoded: [...body.urlEncoded, { id: crypto.randomUUID(), name: '', value: '', enabled: true }] })}
        onUpdateUrlEncoded={(id, changes) => updateBody({ urlEncoded: body.urlEncoded.map((row) => row.id === id ? { ...row, ...changes } : row) })}
        onRemoveUrlEncoded={(id) => updateBody({ urlEncoded: body.urlEncoded.filter((row) => row.id !== id) })}
        onReplaceUrlEncoded={(rows) => updateBody({ urlEncoded: rows.map((row) => ({ ...row, id: crypto.randomUUID() })) })}
        onAddFormData={() => updateBody({ formData: [...body.formData, { id: crypto.randomUUID(), name: '', value: '', filePath: '', enabled: true, kind: 'text' }] })}
        onUpdateFormData={(id, changes) => updateBody({ formData: body.formData.map((row) => row.id === id ? { ...row, ...changes } : row) })}
        onRemoveFormData={(id) => updateBody({ formData: body.formData.filter((row) => row.id !== id) })}
        onBinaryFileChange={(binaryFilePath) => updateBody({ binaryFilePath })}
      /> : content.protocol === 'graphql' ? <>
        <Field label={t('flows.studio.query')}><QueryPanel value={content.query} onChange={(query) => patch({ query })} environmentVariables={variables} schema={null} /></Field>
        <Field label={t('flows.studio.variables')}><RequestBodyPanel value={content.variables} onChange={(value) => patch({ variables: value })} environmentVariables={variables} /></Field>
      </> : <>
        <GrpcSchemaSource rootPath={rootPath} grpc={content.grpc} onChange={updateGrpc} />
        <Field label={t('flows.studio.service')}><Input value={content.grpc.service} onChange={(event) => updateGrpc({ service: event.target.value })} /></Field>
        <Field label={t('flows.studio.method')}><Input value={content.grpc.method} onChange={(event) => updateGrpc({ method: event.target.value })} /></Field>
        <Field label={t('flows.studio.deadline')}><Input type="number" min={1} value={content.grpc.deadlineMs ?? ''} onChange={(event) => updateGrpc({ deadlineMs: event.target.value === '' ? null : Math.max(1, Number(event.target.value)) })} /></Field>
        <Field label={t('flows.studio.message')}><RequestBodyPanel value={content.grpc.message} onChange={(message) => updateGrpc({ message })} environmentVariables={variables} /></Field>
      </>)}
      {tab === 'headers' && <HeadersPanel headers={content.headers.map((header, index) => ({ ...header, id: `flow-header-${index}` }))} environmentVariables={variables}
        onAdd={() => patch({ headers: [...content.headers, { name: '', value: '', enabled: true }] })}
        onUpdate={(id, changes) => patch({ headers: content.headers.map((header, index) => id === `flow-header-${index}` ? { ...header, ...changes } : header) })}
        onRemove={(id) => patch({ headers: content.headers.filter((_, index) => id !== `flow-header-${index}`) })}
        onReplaceAll={(rows) => patch({ headers: rows })}
      />}
      {tab === 'auth' && <AuthorizationPanel idPrefix="flow-authorization" authorization={toAuthorizationState(content.authentication)} environmentVariables={variables} onChange={(changes) => patch({ authentication: toAuthenticationInput({ ...toAuthorizationState(content.authentication), ...changes }) })} />}
      {tab === 'params' && <>
        <p className="flow-inspector-hint">{t('flows.studio.parametersHint')}</p>
        {params.map((param) => <div className="flow-request-parameter flow-request-query-param" key={param.id}><Checkbox aria-label={t('params.enableAria', { name: param.name })} checked={param.enabled} onChange={(event) => updateParams(params.map((row) => row.id === param.id ? { ...row, enabled: event.target.checked } : row))} /><Input aria-label={t('flows.studio.name')} value={param.name} onChange={(event) => updateParams(params.map((row) => row.id === param.id ? { ...row, name: event.target.value } : row))} /><Input aria-label={t('flows.studio.value')} value={param.value} onChange={(event) => updateParams(params.map((row) => row.id === param.id ? { ...row, value: event.target.value } : row))} /><IconButton icon={<TrashIcon size={12} />} label={t('common.remove')} onClick={() => updateParams(params.filter((row) => row.id !== param.id))} /></div>)}
        <Button size="sm" variant="ghost" onClick={() => updateParams([...params, { id: crypto.randomUUID(), name: '', value: '', enabled: true }])}>{t('params.addButton')}</Button>
        {content.routeParams.map((param, index) => <div className="flow-request-parameter" key={index}><Input aria-label={t('flows.studio.name')} value={param.name} onChange={(event) => patch({ routeParams: content.routeParams.map((row, current) => current === index ? { ...row, name: event.target.value } : row) })} /><Input aria-label={t('flows.studio.value')} value={param.value} onChange={(event) => patch({ routeParams: content.routeParams.map((row, current) => current === index ? { ...row, value: event.target.value } : row) })} /><IconButton icon={<TrashIcon size={12} />} label={t('common.remove')} onClick={() => patch({ routeParams: content.routeParams.filter((_, current) => current !== index) })} /></div>)}
        <Button size="sm" variant="ghost" onClick={() => patch({ routeParams: [...content.routeParams, { name: '', value: '' }] })}>{t('flows.studio.add')}</Button>
      </>}
      {tab === 'scripts' && <>
        <Field label={t('flows.studio.preScript')}><RequestBodyPanel value={content.preRequestScript} language="javascript" onChange={(preRequestScript) => patch({ preRequestScript })} /></Field>
        <Field label={t('flows.studio.postScript')}><RequestBodyPanel value={content.postResponseScript} language="javascript" onChange={(postResponseScript) => patch({ postResponseScript })} /></Field>
      </>}
    </div>
    {error && <p role="alert" className="flow-data-notice">{error}</p>}
    <div className="flow-request-save"><Button size="sm" variant="ghost" disabled={!dirty || saving || busy} onClick={onDiscard}>{t('flows.studio.discard')}</Button><Button size="sm" variant="primary" disabled={!dirty || saving || busy} aria-busy={saving || busy} onClick={() => { void save() }}>{t('flows.studio.save')}</Button></div>
  </section>
}
