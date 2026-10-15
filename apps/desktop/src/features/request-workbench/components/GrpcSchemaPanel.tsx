import { pickProtoFiles, pickProtoImportFolder } from '../../../bindings/pick-proto-files'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { IconButton } from '../../../shared/ui/IconButton'
import { Input } from '../../../shared/ui/Input'
import { SegmentedControl } from '../../../shared/ui/SegmentedControl'
import { Spinner, TrashIcon } from '../../../shared/ui/icons'
import { toWorkspaceRelativePath } from '../body-state'
import type { GrpcCallState } from '../collection-tree'
import { describeError } from '../response-summary'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
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

type SourceType = GrpcCallState['schemaSource']['type']

/** Where a gRPC request's services come from, the services found, and the
 * call deadline (spec 0129). Files inside the workspace are kept relative to
 * it, like body files. */
export function GrpcSchemaPanel({
  grpc,
  onChange,
  schema,
  onLoad,
  rootPath,
  pickFiles = pickProtoFiles,
  pickFolder = pickProtoImportFolder,
}: GrpcSchemaPanelProps) {
  const { t } = useLanguage()
  const source = grpc.schemaSource
  const files = source.type === 'protoFiles' ? source.files : []
  const importPaths = source.type === 'protoFiles' ? source.importPaths : []

  const setSource = (type: SourceType) =>
    onChange({ schemaSource: type === 'reflection' ? { type: 'reflection' } : { type: 'protoFiles', files, importPaths } })
  const setProtoFiles = (next: { files?: string[]; importPaths?: string[] }) =>
    onChange({ schemaSource: { type: 'protoFiles', files: next.files ?? files, importPaths: next.importPaths ?? importPaths } })

  const addFiles = async () => {
    const picked = await pickFiles()
    const relative = picked.map((path) => toWorkspaceRelativePath(path, rootPath))
    setProtoFiles({ files: [...files, ...relative.filter((path) => !files.includes(path))] })
  }
  const addFolder = async () => {
    const picked = await pickFolder()
    if (picked === null) return
    const relative = toWorkspaceRelativePath(picked, rootPath)
    if (!importPaths.includes(relative)) setProtoFiles({ importPaths: [...importPaths, relative] })
  }

  return (
    <div className="rw-panel rw-grpc-schema">
      <section className="rw-grpc-schema-section">
        <h3 className="rw-grpc-schema-title">{t('grpc.schemaSource')}</h3>
        <SegmentedControl<SourceType>
          layout="inline"
          size="sm"
          ariaLabel={t('grpc.schemaSource')}
          value={source.type}
          onChange={setSource}
          options={[
            { value: 'reflection', label: t('grpc.sourceReflection') },
            { value: 'protoFiles', label: t('grpc.sourceProtoFiles') },
          ]}
        />
        {source.type === 'reflection' ? (
          <p className="rw-grpc-schema-hint">{t('grpc.reflectionHint')}</p>
        ) : (
          <div className="rw-grpc-schema-files">
            <PathList
              label={t('grpc.filesLabel')}
              paths={files}
              empty={t('grpc.protoFilesEmpty')}
              onRemove={(path) => setProtoFiles({ files: files.filter((item) => item !== path) })}
            />
            <Button variant="ghost" size="sm" onClick={() => void addFiles()}>
              {t('grpc.addProtoFiles')}
            </Button>
            <PathList
              label={t('grpc.importPathsLabel')}
              paths={importPaths}
              empty={t('grpc.importPathsEmpty')}
              onRemove={(path) => setProtoFiles({ importPaths: importPaths.filter((item) => item !== path) })}
            />
            <Button variant="ghost" size="sm" onClick={() => void addFolder()}>
              {t('grpc.addImportPath')}
            </Button>
          </div>
        )}
      </section>

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

function PathList({ label, paths, empty, onRemove }: { label: string; paths: string[]; empty: string; onRemove: (path: string) => void }) {
  const { t } = useLanguage()
  return (
    <div className="rw-grpc-paths">
      <span className="rw-grpc-paths-label">{label}</span>
      {paths.length === 0 ? (
        <span className="rw-grpc-schema-hint">{empty}</span>
      ) : (
        <ul className="rw-grpc-paths-list" aria-label={label}>
          {paths.map((path) => (
            <li key={path}>
              <span className="rw-grpc-paths-path" title={path}>
                {path}
              </span>
              <IconButton icon={<TrashIcon size={12} />} label={t('grpc.removePath', { path })} onClick={() => onRemove(path)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
