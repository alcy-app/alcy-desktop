/**
 * Numeric block settings (Sleep duration, While limit, Increment amount, mock
 * wait timeout and call count) are text: a number or a `{{variable}}` the
 * engine resolves when the block runs.
 */

export interface NumberSettingRules {
  min?: number
  max?: number
  integer?: boolean
}

export type NumberSettingIssue = 'notANumber' | 'outOfRange'

/** True when the setting is read from a variable or node reference at run time. */
export function isTemplateSetting(value: string): boolean {
  return value.includes('{{')
}

/** The literal number a setting holds, or null for templates, empty or invalid text. */
export function literalNumber(value: string): number | null {
  const text = value.trim()
  if (text === '' || isTemplateSetting(text)) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

/** What is wrong with a literal setting; templates are only checked when the block runs. */
export function numberSettingIssue(value: string, rules: NumberSettingRules): NumberSettingIssue | null {
  if (isTemplateSetting(value)) return null
  const number = literalNumber(value)
  if (number === null || (rules.integer && !Number.isInteger(number))) return 'notANumber'
  if ((rules.min !== undefined && number < rules.min) || (rules.max !== undefined && number > rules.max)) return 'outOfRange'
  return null
}
