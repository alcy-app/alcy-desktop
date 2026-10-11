import { useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { comboFromEvent, comboFromMouseEvent, type KeyCombo, type ShortcutAction } from '../../shared/shortcuts/shortcuts'
import { Button } from '../../shared/ui/Button'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Input } from '../../shared/ui/Input'
import { Modal } from '../../shared/ui/Modal'
import { ShortcutKeys } from './ShortcutKeys'
import { formatComboForDisplay } from './shortcut-display'

export type CaptureEvaluation =
  | { kind: 'ok' }
  | { kind: 'conflict'; owner: ShortcutAction }
  | { kind: 'needsModifier' | 'reserved' | 'duplicate' | 'mouseNotAllowed' }

interface ShortcutCaptureModalProps {
  actionLabel: string
  /** A ação aceita também um botão do mouse (ações do canvas de flows). */
  acceptsMouse?: boolean
  evaluate: (combo: KeyCombo) => CaptureEvaluation
  onConfirm: (combo: KeyCombo) => void
  onClose: () => void
}

/** Grava uma combinação: cada tecla pressionada substitui a anterior, Enter
 * confirma e Esc cancela. Enter sem nada gravado vira a própria combinação.
 * Com `acceptsMouse`, um clique na área própria grava o botão do mouse (com os
 * modificadores pressionados) — o foco fica no campo, então Enter confirma. */
export function ShortcutCaptureModal({ actionLabel, acceptsMouse, evaluate, onConfirm, onClose }: ShortcutCaptureModalProps) {
  const { t } = useLanguage()
  const [combo, setCombo] = useState<KeyCombo | null>(null)
  const comboText = combo ? formatComboForDisplay(combo, t) : ''
  const evaluation = combo ? evaluate(combo) : null
  const canConfirm = evaluation?.kind === 'ok' || evaluation?.kind === 'conflict'

  return (
    <Modal
      title={t('settings.shortcuts.captureTitle', { action: actionLabel })}
      closeAriaLabel={t('settings.close')}
      onClose={onClose}
      className="ui-modal--md settings-shortcut-capture"
    >
      {(requestClose) => {
        const confirm = () => {
          if (!combo || !canConfirm) return
          onConfirm(combo)
          requestClose()
        }

        return (
          <>
            <p className="ui-modal-description">{t('settings.shortcuts.captureHint')}</p>
            <Input
              autoFocus
              readOnly
              aria-label={t('settings.shortcuts.captureAria')}
              placeholder={t('settings.shortcuts.capturePlaceholder')}
              value={comboText}
              // A tecla é só da captura: nem o Esc/Tab do modal nem os atalhos
              // globais (ouvidos no `document`) recebem o evento.
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                event.preventDefault()
                event.stopPropagation()
                const plain = !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
                if (plain && event.key === 'Escape') {
                  requestClose()
                  return
                }
                if (plain && event.key === 'Enter' && canConfirm) {
                  confirm()
                  return
                }
                const next = comboFromEvent(event)
                if (next) setCombo(next)
              }}
            />
            {acceptsMouse && (
              <>
                <p className="ui-modal-description">{t('settings.shortcuts.captureMouseHint')}</p>
                <div
                  className="settings-shortcut-mouse-area"
                  aria-label={t('settings.shortcuts.captureMouseAria')}
                  // `preventDefault` no mousedown mantém o foco no campo (Enter
                  // confirma) e evita a rolagem automática do botão do meio; o
                  // menu de contexto nativo do botão direito também é suprimido.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    const next = comboFromMouseEvent(event)
                    if (next) setCombo(next)
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  {t('settings.shortcuts.captureMouseArea')}
                </div>
              </>
            )}
            {combo && (
              <div className="settings-shortcut-capture-preview" aria-hidden="true">
                <ShortcutKeys combo={combo} />
              </div>
            )}
            {evaluation?.kind === 'conflict' && (
              <p className="settings-shortcut-warning" role="alert">
                {t('settings.shortcuts.conflict', {
                  combo: comboText,
                  action: t(`settings.shortcuts.action.${evaluation.owner}`),
                })}
              </p>
            )}
            {evaluation && evaluation.kind !== 'ok' && evaluation.kind !== 'conflict' && (
              <InlineAlert>{t(`settings.shortcuts.${evaluation.kind}`, { combo: comboText })}</InlineAlert>
            )}
            <div className="ui-modal-actions">
              <Button variant="ghost" onClick={requestClose}>
                {t('settings.shortcuts.cancel')}
              </Button>
              <Button disabled={!canConfirm} onClick={confirm}>
                {evaluation?.kind === 'conflict' ? t('settings.shortcuts.replace') : t('settings.shortcuts.confirm')}
              </Button>
            </div>
          </>
        )
      }}
    </Modal>
  )
}
