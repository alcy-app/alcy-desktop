import { Fragment } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import type { KeyCombo } from '../../shared/shortcuts/shortcuts'
import { comboDisplayParts } from './shortcut-display'

/** Desenha a combinação como teclas separadas: `Ctrl` + `S`, ou `Ctrl` +
 * `Botão direito`. */
export function ShortcutKeys({ combo }: { combo: KeyCombo }) {
  const { t } = useLanguage()
  return (
    <span className="settings-keys">
      {comboDisplayParts(combo, t).map((part, index) => (
        <Fragment key={part}>
          {index > 0 && (
            <span className="settings-keys-plus" aria-hidden="true">
              +
            </span>
          )}
          <kbd>{part}</kbd>
        </Fragment>
      ))}
    </span>
  )
}
