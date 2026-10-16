import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { Input } from '../../../shared/ui/Input'
import { Spinner } from '../../../shared/ui/icons'
import type { GrpcCallState } from '../collection-tree'
import { describeError } from '../response-summary'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
import { GrpcSchemaSource } from './GrpcSchemaSource'
import './grpc.css'

interface GrpcSchemaPanelProps {
  grpc: GrpcCallState
  onChange: (patch: Partial<GrpcCallState>) => void
  schema: GrpcSchemaLoadState
  onLoad: (forceRefresh: boolean) => void
  rootPath: string
  pickFiles?: () => Promise<string[]>
  pickFolder?: () => Promise<string | null>
}

/** Where a gRPC request's services come from, the services found, and the
 * call deadline (spec 0129). Files inside the workspace are kept relative to
 * it, like body files. */
export function GrpcSchemaPanel({
  grpc,
  onChange,
  schema,
  onLoad,
  rootPath,
  pickFiles,
  pickFolder,
}: GrpcSchemaPanelProps) {
  const { t } = useLanguage()

  return (
    <div className="rw-panel rw-grpc-schema">
      <GrpcSchemaSource grpc={grpc} onChange={onChange} rootPath={rootPath} pickFiles={pickFiles} pickFolder={pickFolder} />

      <section className="rw-grpc-schema-section">
        <div className="rw-grpc-schema-heading">
          <h3 className="rw-grpc-schema-title">{t('grpc.servicesTitle')}</h3>
          <Button variant="ghost" size="sm" disabled={schema.status === 'loading'} onClick={() => onLoad(schema.status !== 'idle')}>
            {schema.status === 'idle' ? t('grpc.loadServices') : t('grpc.reloadServices')}
          </Button>
        </div>
        {schema.status === 'loading' && (
          <p className="rw-grpc-schema-hint" role="status">
            <Spinner size={12} /> {t('grpc.loadingServices')}
          </p>
        )}
        {schema.status === 'error' && (
          <p className="rw-grpc-schema-hint rw-grpc-schema-hint--error" role="alert">
            {describeError(t, schema.error)}
          </p>
        )}
        {schema.status === 'success' && schema.schema.services.length === 0 && (
          <p className="rw-grpc-schema-hint">{t('grpc.noServices')}</p>
        )}
        {schema.status === 'success' && schema.schema.services.length > 0 && (
          <ul className="rw-grpc-services" aria-label={t('grpc.servicesTitle')}>
            {schema.schema.services.map((service) => (
              <li key={service.name}>
                <span className="rw-grpc-services-name">{service.name}</span>
                <ul>
                  {service.methods.map((method) => {
                    const selected = grpc.service === service.name && grpc.method === method.name
                    return (
                      <li key={method.name}>
                        <button
                          type="button"
                          className={`rw-grpc-services-method${selected ? ' rw-grpc-services-method--selected' : ''}`}
                          aria-pressed={selected}
                          onClick={() => onChange({ service: service.name, method: method.name })}
                        >
                          <span>{method.name}</span>
                          <span className="rw-grpc-services-types">
                            {method.inputType} → {method.outputType}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rw-grpc-schema-section">
        <label className="rw-grpc-schema-title" htmlFor="grpc-deadline">
          {t('grpc.deadlineLabel')}
        </label>
        <Input
          id="grpc-deadline"
          className="rw-grpc-deadline"
          type="number"
          min={1}
          inputMode="numeric"
          placeholder={t('grpc.deadlinePlaceholder')}
          value={grpc.deadlineMs ?? ''}
          onChange={(event) => {
            const value = Number.parseInt(event.target.value, 10)
            onChange({ deadlineMs: Number.isFinite(value) && value > 0 ? value : null })
          }}
        />
      </section>
    </div>
  )
}
