import type { EnvironmentVariableDto } from '../../bindings/list-environments'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'

export interface TextSegment {
  type: 'text'
  value: string
}

export interface VariableSegment {
  type: 'variable'
  raw: string
  name: string
}

export type TemplateSegment = TextSegment | VariableSegment

/**
 * Divide um texto em segmentos de texto simples e placeholders `{{nome}}`,
 * para fins de destaque visual (não é o resolvedor real — esse fica no
 * backend, em `alcy_app::resolve_variables`). Mesma regra: `{{` sem `}}`
 * correspondente fica literal, não é tratado como placeholder.
 */
export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = []
  let rest = template

  for (;;) {
    const start = rest.indexOf('{{')
    if (start === -1) {
      if (rest) segments.push({ type: 'text', value: rest })
      break
    }
    if (start > 0) {
      segments.push({ type: 'text', value: rest.slice(0, start) })
    }

    const afterOpen = rest.slice(start + 2)
    const end = afterOpen.indexOf('}}')
    if (end === -1) {
      segments.push({ type: 'text', value: rest.slice(start) })
      break
    }

    const inner = afterOpen.slice(0, end)
    segments.push({ type: 'variable', raw: `{{${inner}}}`, name: inner.trim() })
    rest = afterOpen.slice(end + 2)
  }

  return segments
}

export interface OpenTemplateQuery {
  /** Índice, na string original, logo após o `{{` que ainda está sendo digitado. */
  start: number
  query: string
}

/** Procura o último `{{` antes do cursor que ainda não foi fechado por um
 * `}}` — mesma regra de "placeholder aberto" que `parseTemplate` usa para
 * destaque visual, mas aplicada só ao trecho antes do cursor, para decidir
 * se o autocomplete de variáveis deve aparecer enquanto o usuário digita
 * (`TemplateHighlightedField`). */
export function findOpenTemplateQuery(value: string, cursor: number): OpenTemplateQuery | null {
  const beforeCursor = value.slice(0, cursor)
  const openIndex = beforeCursor.lastIndexOf('{{')
  if (openIndex === -1) return null
  const between = beforeCursor.slice(openIndex + 2)
  if (between.includes('}}')) return null
  return { start: openIndex + 2, query: between }
}

export type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** Descreve uma variável em uma linha de texto: `nome = valor`, valor mascarado se sensível, ou aviso de variável indefinida.
 * O tooltip dos campos e editores usa o cartão de `variable-preview.ts`. */
export function describeVariable(t: Translate, name: string, variables: EnvironmentVariableDto[]): string {
  const match = variables.find((variable) => variable.name === name)
  if (!match) {
    return t('templateField.undefinedVariable', { name })
  }
  const value = match.sensitive ? '••••••••' : match.value || t('common.empty')
  return `${name} = ${value}`
}
