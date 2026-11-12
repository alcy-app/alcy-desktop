import type { ChangedItemDto } from '../../bindings/version-control-types'
import { FEATURE_FLAGS } from '../../shared/feature-flags'
import type { TranslationKey } from '../../shared/i18n/translations'

/** Rótulos amigáveis para os arquivos rastreados pelo controle de versão. */
export const FILE_LABELS: Record<string, string> = {
  'alcy-workspace.json': 'Workspace',
  'alcy-collections.json': 'Coleções',
  'alcy-flows.json': 'Flows',
  'alcy-api-docs.json': 'Documentação',
  'alcy-environments.json': 'Ambientes',
  // Com a funcionalidade desligada, o arquivo (se mudar) aparece só pelo nome.
  ...(FEATURE_FLAGS.valueMonitors ? { 'alcy-value-monitors.json': 'Monitores' } : {}),
  'alcy-mock-servers.json': 'Mock servers',
}

/** Versioned folders: each of their files shows under the folder's label. */
const FOLDER_LABELS: Record<string, string> = {
  ...(FEATURE_FLAGS.documents ? { 'alcy-documents/': 'Documentos' } : {}),
  'alcy-flow-assets/': 'Arquivos de flows',
}

/** Friendly label of a versioned file; the name itself when there is none. */
export function fileLabel(name: string): string {
  const folder = Object.keys(FOLDER_LABELS).find((prefix) => name.startsWith(prefix))
  return FILE_LABELS[name] ?? (folder ? FOLDER_LABELS[folder] : name)
}

/** Rótulo do tipo de item alterado; o de uma funcionalidade desligada cai no genérico. */
export function itemKindLabelKey(kind: ChangedItemDto['itemKind']): TranslationKey {
  if (kind === 'monitor' && !FEATURE_FLAGS.valueMonitors) return 'vc.item.generic'
  return `vc.item.${kind}`
}
