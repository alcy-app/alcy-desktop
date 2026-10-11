import type { ChangedItemDto } from '../../bindings/gitlab-types'
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
}

/** Rótulo do tipo de item alterado; o de uma funcionalidade desligada cai no genérico. */
export function itemKindLabelKey(kind: ChangedItemDto['itemKind']): TranslationKey {
  if (kind === 'monitor' && !FEATURE_FLAGS.valueMonitors) return 'vc.item.generic'
  return `vc.item.${kind}`
}
