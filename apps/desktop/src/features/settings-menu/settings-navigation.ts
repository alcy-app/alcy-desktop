import { FEATURE_FLAGS } from '../../shared/feature-flags'
import { isVersionControlEnabled } from '../../shared/version-control-enabled'
import type { TranslationKey } from '../../shared/i18n/translations'
import { BranchIcon, ComponentsIcon, GearIcon, KeyboardIcon, LockIcon, ProxyIcon, RefreshIcon, SparkleIcon } from '../../shared/ui/icons'

export const SETTINGS_PAGES = [
  { key: 'interface', group: 'preferences', icon: ComponentsIcon },
  { key: 'shortcuts', group: 'preferences', icon: KeyboardIcon },
  { key: 'requests', group: 'requests', icon: GearIcon },
  { key: 'network', group: 'requests', icon: ProxyIcon },
  { key: 'privacy', group: 'requests', icon: LockIcon },
  { key: 'agent', group: 'tools', icon: SparkleIcon },
  { key: 'git', group: 'tools', icon: BranchIcon },
  { key: 'about', group: 'application', icon: RefreshIcon },
] as const
export type SettingsPage = (typeof SETTINGS_PAGES)[number]['key']
/** Legacy destinations remain valid for existing entry points. */
export type SettingsCategory = SettingsPage | 'general' | 'appearance' | 'security' | 'telemetry' | 'updates'

export function pageAvailable(page: SettingsPage) {
  return page !== 'agent' && page !== 'git' || (page === 'agent' ? FEATURE_FLAGS.agent : FEATURE_FLAGS.localGit)
}

export function settingsDestination(category: SettingsCategory): { page: SettingsPage; target?: string } {
  switch (category) {
    case 'general': case 'appearance': return { page: 'interface' }
    case 'security': return { page: 'privacy', target: 'har' }
    case 'telemetry': return { page: 'privacy', target: FEATURE_FLAGS.usageEvents ? 'telemetry' : undefined }
    case 'updates': return { page: 'about', target: FEATURE_FLAGS.updates ? 'updates' : undefined }
    default: return { page: pageAvailable(category) ? category : 'interface' }
  }
}

interface SettingEntry {
  page: SettingsPage
  target: string
  label: TranslationKey
  hint?: TranslationKey
  keywords?: string
  available?: () => boolean
}

/** Only static labels are searchable: never drafts, secrets or recorded events. */
export const SETTINGS_INDEX: SettingEntry[] = [
  { page: 'interface', target: 'language', label: 'settings.languageLabel', keywords: 'language idioma português english' },
  { page: 'interface', target: 'theme', label: 'settings.themeLabel', keywords: 'theme tema aparência appearance dark light claro escuro sistema system' },
  { page: 'interface', target: 'text-scale', label: 'settings.textScaleLabel', keywords: 'zoom fonte font acessibilidade accessibility' },
  { page: 'interface', target: 'icon-scale', label: 'settings.iconScaleLabel', keywords: 'zoom ícones icons acessibilidade accessibility' },
  { page: 'shortcuts', target: 'shortcuts', label: 'settings.category.shortcuts', keywords: 'keyboard teclado mouse shortcuts atalhos' },
  { page: 'requests', target: 'timeout', label: 'settings.timeoutLabel', hint: 'settings.timeoutHint' },
  { page: 'requests', target: 'response-limit', label: 'settings.responseLimitLabel', hint: 'settings.responseLimitHint' },
  { page: 'requests', target: 'autocomplete', label: 'settings.schemaAutocompleteLabel', hint: 'settings.schemaAutocompleteHint' },
  { page: 'network', target: 'proxy', label: 'settings.proxyLabel', keywords: 'pac url script system sistema proxy' },
  { page: 'network', target: 'tls', label: 'settings.tlsVerifyLabel', hint: 'settings.tlsVerifyHint', keywords: 'ssl tls https' },
  { page: 'network', target: 'certificates', label: 'settings.customCaLabel', hint: 'settings.customCaHint', keywords: 'ca tls ssl' },
  { page: 'privacy', target: 'history', label: 'settings.historyRetentionLabel', hint: 'settings.historyRetentionHint' },
  { page: 'privacy', target: 'history-responses', label: 'settings.saveHistoryResponsesLabel', hint: 'settings.saveHistoryResponsesHint' },
  { page: 'privacy', target: 'har', label: 'settings.securityHarLabel', hint: 'settings.securityHarRedactHint' },
  { page: 'privacy', target: 'sensitive-sync', label: 'settings.securitySyncLabel', hint: 'settings.securitySyncProtectHint', available: isVersionControlEnabled },
  { page: 'privacy', target: 'body-files', label: 'settings.securityBodyFilesLabel', hint: 'settings.securityBodyFilesHint', keywords: 'arquivo file upload form-data binary workspace' },
  { page: 'privacy', target: 'telemetry', label: 'settings.telemetryLabel', keywords: 'telemetria telemetry dados uso usage privacidade privacy', available: () => FEATURE_FLAGS.usageEvents },
  { page: 'agent', target: 'agent-chat', label: 'settings.agent.enableChat', hint: 'settings.agent.enableChatHint' },
  { page: 'agent', target: 'agent-context', label: 'settings.agent.disableContextOptions', hint: 'settings.agent.disableContextOptionsHint' },
  { page: 'agent', target: 'agent-dock', label: 'settings.agent.dockLabel', hint: 'settings.agent.dockHint' },
  { page: 'agent', target: 'agent-providers', label: 'settings.agent.title', hint: 'settings.agent.subtitle', keywords: 'api key chave modelo model provider provedor' },
  { page: 'git', target: 'git', label: 'settings.git.authorLabel', hint: 'settings.git.authorHint', keywords: 'nome name email commit git' },
  { page: 'about', target: 'release-notes', label: 'settings.releaseNotesLabel', keywords: 'version versão novidades changelog release notes' },
  { page: 'about', target: 'updates', label: 'settings.category.updates', keywords: 'updates atualizações download preview prévias inicialização startup', available: () => FEATURE_FLAGS.updates },
]

export function normalizeSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim()
}
