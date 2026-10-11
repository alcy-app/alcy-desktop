import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { comboParts, isMouseKey, type KeyCombo } from '../../shared/shortcuts/shortcuts'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** As partes da combinação como o usuário as lê: botões do mouse traduzidos
 * ("Botão direito"), teclas como estão. */
export function comboDisplayParts(combo: KeyCombo, t: Translate): string[] {
  return comboParts(combo).map((part) => (isMouseKey(part) ? t(`settings.shortcuts.mouse.${part}`) : part))
}

export function formatComboForDisplay(combo: KeyCombo, t: Translate): string {
  return comboDisplayParts(combo, t).join('+')
}
