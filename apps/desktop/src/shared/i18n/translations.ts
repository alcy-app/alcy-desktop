import en from './locales/en'
import ptBR from './locales/pt-BR'
import type { TranslationKey } from './locales/pt-BR'

export type { TranslationKey }
export type Language = 'pt-BR' | 'en'

export const LANGUAGE_STORAGE_KEY = 'alcy:language'

export const DEFAULT_LANGUAGE: Language = 'pt-BR'

export const LANGUAGE_NAMES: Record<Language, string> = {
  'pt-BR': 'Português (Brasil)',
  en: 'English',
}

const dictionaries: Record<Language, Record<TranslationKey, string>> = {
  'pt-BR': ptBR,
  en,
}

export type TranslationParams = Record<string, string | number>

/** Placeholders use `{name}` — distinct from the `{{variable}}` syntax users type for their own GraphQL endpoint templates. */
export function translate(language: Language, key: TranslationKey, params?: TranslationParams): string {
  const template = dictionaries[language][key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}
