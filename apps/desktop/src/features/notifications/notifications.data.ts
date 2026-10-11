import type { AppNotification } from './notifications.types'

/**
 * Avisos exibidos no sino da barra inferior. Enquanto não há servidor de
 * notificações, novos anúncios, atualizações e alertas são adicionados aqui.
 *
 * - `id` precisa ser único e nunca reaproveitado: um id novo volta a contar
 *   como não lido para todos os usuários.
 * - `kind`: 'announcement' (anúncio), 'update' (nova versão) ou 'alert'.
 * - `date` no formato `AAAA-MM-DD`; a lista é exibida da mais recente para a
 *   mais antiga, independentemente da ordem aqui.
 * - `title` e `message` em pt-BR e en.
 * - `message` aceita `\n` para quebrar linha e links no formato
 *   `[texto](https://…)`, abertos no navegador do sistema. Só http(s) vira
 *   link; outros formatos aparecem como texto literal.
 * - `details` (opcional, só em 'update'): Markdown em pt-BR e en com os
 *   detalhes da atualização. Com ele, clicar no card abre uma aba com o texto.
 */
export const NOTIFICATIONS: AppNotification[] = []
