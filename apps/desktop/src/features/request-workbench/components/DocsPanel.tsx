import { useState } from 'react'
import type { MediaDocDto, ParameterDocDto, ParameterLocation, RequestDocsDto } from '../../../bindings/get-request-docs'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { InlineAlert } from '../../../shared/ui/InlineAlert'
import { ChevronDownIcon, ChevronRightIcon } from '../../../shared/ui/icons'
import { parametersIn, resolveSchema, schemaDetails, schemaTypeLabel } from '../schema-docs'
import type { SchemaMap } from '../schema-docs'
import type { RequestDocsState } from '../use-request-docs'
import { SchemaTree } from './SchemaTree'
import './docs-panel.css'

interface DocsPanelProps {
  state: RequestDocsState
}

const LOCATIONS: ParameterLocation[] = ['path', 'query', 'header', 'cookie']

const LOCATION_KEYS = {
  path: 'docs.locationPath',
  query: 'docs.locationQuery',
  header: 'docs.locationHeader',
  cookie: 'docs.locationCookie',
} as const

const SOURCE_KIND_LABELS = { openapi: 'OpenAPI', postman: 'Postman', insomnia: 'Insomnia', bruno: 'Bruno' } as const

/** Aba "Docs": a documentação importada da chamada (ADR 0035) — descrição,
 * parâmetros, corpo, respostas e schemas. Futuramente também a documentação
 * escrita à mão. */
export function DocsPanel({ state }: DocsPanelProps) {
  const { t } = useLanguage()

  if (state.status === 'none') {
    return (
      <div className="rw-panel docs-panel">
        <EmptyState title={t('docs.emptyTitle')} description={t('docs.emptyDescription')} />
      </div>
    )
  }
  if (state.status === 'loading') {
    return (
      <div className="rw-panel docs-panel">
        <p className="docs-status" role="status">
          {t('docs.loading')}
        </p>
      </div>
    )
  }
  if (state.status === 'missing') {
    return (
      <div className="rw-panel docs-panel">
        <EmptyState title={t('docs.missingTitle')} description={t('docs.missingDescription')} />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="rw-panel docs-panel">
        <InlineAlert>{t('docs.loadError', { message: state.message })}</InlineAlert>
      </div>
    )
  }

  return <DocsContent docs={state.docs} />
}

function DocsContent({ docs }: { docs: RequestDocsDto }) {
  const { t } = useLanguage()
  const schemaNames = Object.keys(docs.schemas)

  return (
    <div className="rw-panel docs-panel">
      <header className="docs-header">
        <div className="docs-title-row">
          {docs.summary && <h3 className="docs-title">{docs.summary}</h3>}
          {docs.deprecated && <Badge tone="warning">{t('common.deprecated')}</Badge>}
        </div>
        <p className="docs-source">
          {t('docs.importedFrom', { title: docs.sourceTitle, kind: SOURCE_KIND_LABELS[docs.sourceKind] })}
        </p>
        {docs.description && <p className="docs-description docs-description--lead">{docs.description}</p>}
      </header>

      {LOCATIONS.map((location) => {
        const parameters = parametersIn(docs, location)
        if (parameters.length === 0) return null
        return (
          <section key={location} className="docs-section" aria-label={t(LOCATION_KEYS[location])}>
            <h4 className="docs-section-title">{t(LOCATION_KEYS[location])}</h4>
            <ParametersTable parameters={parameters} schemas={docs.schemas} />
          </section>
        )
      })}

      {docs.requestBody && (
        <section className="docs-section" aria-label={t('docs.requestBody')}>
          <h4 className="docs-section-title">
            {t('docs.requestBody')}
            {docs.requestBody.required && (
              <span className="docs-required" title={t('docs.required')}>
                {' '}*
              </span>
            )}
          </h4>
          {docs.requestBody.description && <p className="docs-description">{docs.requestBody.description}</p>}
          {docs.requestBody.content.map((media) => (
            <MediaBlock key={media.mediaType} media={media} schemas={docs.schemas} />
          ))}
        </section>
      )}

      {docs.responses.length > 0 && (
        <section className="docs-section" aria-label={t('docs.responses')}>
          <h4 className="docs-section-title">{t('docs.responses')}</h4>
          {docs.responses.map((response) => (
            <div key={response.status} className="docs-response">
              <div className="docs-response-header">
                <Badge tone={statusTone(response.status)} className="docs-status-badge">
                  {response.status}
                </Badge>
                {response.description && <span className="docs-description">{response.description}</span>}
              </div>
              {response.content.map((media) => (
                <MediaBlock key={media.mediaType} media={media} schemas={docs.schemas} />
              ))}
            </div>
          ))}
        </section>
      )}

      {schemaNames.length > 0 && (
        <section className="docs-section" aria-label={t('docs.schemas')}>
          <h4 className="docs-section-title">{t('docs.schemas')}</h4>
          {schemaNames.map((name) => (
            <SchemaTree key={name} name={name} node={docs.schemas[name]} schemas={docs.schemas} defaultExpanded={false} />
          ))}
        </section>
      )}
    </div>
  )
}

function statusTone(status: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (status.startsWith('2')) return 'success'
  if (status.startsWith('3')) return 'warning'
  if (status.startsWith('4') || status.startsWith('5')) return 'error'
  return 'neutral'
}

function ParametersTable({ parameters, schemas }: { parameters: ParameterDocDto[]; schemas: SchemaMap }) {
  const { t } = useLanguage()
  return (
    <table className="docs-parameters">
      <thead>
        <tr>
          <th scope="col">{t('common.name')}</th>
          <th scope="col">{t('docs.type')}</th>
          <th scope="col">{t('docs.description')}</th>
        </tr>
      </thead>
      <tbody>
        {parameters.map((parameter) => {
          const resolved = parameter.schema ? resolveSchema(parameter.schema, schemas) : null
          const details = resolved ? schemaDetails(resolved, t) : []
          if (parameter.example !== null) details.push(t('docs.exampleValue', { value: parameter.example }))
          return (
            <tr key={parameter.name}>
              <td className="docs-parameter-name">
                {parameter.name}
                {parameter.required && (
                  <span className="docs-required" title={t('docs.required')}>
                    {' '}*
                  </span>
                )}
                {parameter.deprecated && (
                  <Badge tone="warning" className="docs-badge">
                    {t('common.deprecated')}
                  </Badge>
                )}
              </td>
              <td className="docs-parameter-type">{parameter.schema ? schemaTypeLabel(parameter.schema) : '—'}</td>
              <td>
                {parameter.description && <p className="docs-description">{parameter.description}</p>}
                {details.map((detail) => (
                  <p key={detail} className="docs-schema-detail">
                    {detail}
                  </p>
                ))}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function MediaBlock({ media, schemas }: { media: MediaDocDto; schemas: SchemaMap }) {
  const { t } = useLanguage()
  const [showExample, setShowExample] = useState(false)
  return (
    <div className="docs-media">
      <p className="docs-media-type">{media.mediaType}</p>
      {media.schema && <SchemaTree node={media.schema} schemas={schemas} />}
      {media.example !== null && (
        <>
          <button
            type="button"
            className="docs-example-toggle"
            aria-expanded={showExample}
            onClick={() => setShowExample((current) => !current)}
          >
            {showExample ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            {t('docs.example')}
          </button>
          {showExample && <pre className="docs-example">{media.example}</pre>}
        </>
      )}
    </div>
  )
}
