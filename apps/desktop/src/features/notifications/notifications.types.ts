import type { Language } from '../../shared/i18n/translations'

export type NotificationKind = 'announcement' | 'update' | 'alert'

export type LocalizedText = Record<Language, string>

export interface AppNotification {
  /** Único e estável: é a chave usada para lembrar o que já foi lido. */
  id: string
  kind: NotificationKind
  /** Data no formato ISO `AAAA-MM-DD`. */
  date: string
  title: LocalizedText
  message: LocalizedText
  /**
   * Texto em Markdown aberto numa aba ao clicar no card. Só vale para
   * notificações de atualização (ex.: notas da release).
   */
  details?: LocalizedText
}
