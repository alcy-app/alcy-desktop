import { formatJsonBody, formatPartialJsonBody } from './json-format'
import { formatXmlBody } from './xml-format'

/**
 * Escolhe o formatador do corpo de resposta — usado tanto na thread
 * principal quanto em `response-format.worker.ts`, sem depender de nenhum
 * dos dois. `partial`: o texto é o acumulado de um corpo ainda carregando,
 * então JSON pode estar truncado e usa o formatador tolerante.
 */
export function formatResponseText(text: string, language: 'json' | 'xml', partial: boolean): string {
  if (language === 'xml') return formatXmlBody(text)
  return partial ? formatPartialJsonBody(text) : formatJsonBody(text)
}
