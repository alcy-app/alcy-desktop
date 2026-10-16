import { pickProtoFiles, pickProtoImportFolder } from '../../../bindings/pick-proto-files'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { IconButton } from '../../../shared/ui/IconButton'
import { SegmentedControl } from '../../../shared/ui/SegmentedControl'
import { TrashIcon } from '../../../shared/ui/icons'
import { toWorkspaceRelativePath } from '../body-state'
import type { GrpcCallState } from '../collection-tree'

interface GrpcSchemaSourceProps {
  grpc: GrpcCallState
  onChange: (patch: Partial<GrpcCallState>) => void
  rootPath: string
  pickFiles?: () => Promise<string[]>
  pickFolder?: () => Promise<string | null>
}

type SourceType = GrpcCallState['schemaSource']['type']

/** Schema source and workspace-relative proto paths, shared by the URL bar and settings. */
export function GrpcSchemaSource({ grpc, onChange, rootPath, pickFiles = pickProtoFiles, pickFolder = pickProtoImportFolder }: GrpcSchemaSourceProps) {
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
