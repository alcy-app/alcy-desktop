import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import {
  findConflict,
  isCanvasAction,
  isDefaultBinding,
  sameCombo,
  SHORTCUT_ACTIONS,
  validateCombo,
  type KeyCombo,
  type ShortcutAction,
} from '../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../shared/shortcuts/use-shortcuts'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { CloseIcon, PlusIcon, RefreshIcon } from '../../shared/ui/icons'
import { ShortcutCaptureModal, type CaptureEvaluation } from './ShortcutCaptureModal'
import { ShortcutKeys } from './ShortcutKeys'
import { formatComboForDisplay } from './shortcut-display'
import { SHORTCUT_GROUPS } from './shortcut-groups'

interface SlotRef {
  action: ShortcutAction
  slot: number
}

const SLOTS = [0, 1] as const

export function ShortcutsSection() {
  const { t } = useLanguage()
  const { bindings, assignShortcut, removeShortcut, resetShortcut, resetAllShortcuts } = useShortcuts()
  const [capturing, setCapturing] = useState<SlotRef | null>(null)
  // Ao fechar a captura o foco volta para a célula editada, que pode ter
  // trocado de botão ("Adicionar" vira o atalho gravado).
  const [focusSlot, setFocusSlot] = useState<SlotRef | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)

  useEffect(() => {
    if (!focusSlot) return
    tableRef.current?.querySelector<HTMLButtonElement>(`[data-slot="${focusSlot.action}-${focusSlot.slot}"]`)?.focus()
  }, [focusSlot])

  const actionLabel = (action: ShortcutAction) => t(`settings.shortcuts.action.${action}`)
  const allDefault = SHORTCUT_ACTIONS.every((action) => isDefaultBinding(bindings, action))

  const evaluate = ({ action, slot }: SlotRef) => (combo: KeyCombo): CaptureEvaluation => {
    const validation = validateCombo(combo, action)
    if (validation !== 'ok') return { kind: validation }
    if (bindings[action].some((bound, index) => index !== slot && sameCombo(bound, combo))) return { kind: 'duplicate' }
    const owner = findConflict(bindings, combo, action)
    return owner ? { kind: 'conflict', owner } : { kind: 'ok' }
  }

  const renderSlot = (action: ShortcutAction, slot: number) => {
    const label = actionLabel(action)
    const combo = bindings[action].at(slot)
    const open = () => {
      setFocusSlot(null)
      setCapturing({ action, slot })
    }

    if (combo) {
      const text = formatComboForDisplay(combo, t)
      return (
        <div className="settings-shortcut-cell">
          <button
            type="button"
            className="settings-shortcut-edit"
            data-slot={`${action}-${slot}`}
            aria-label={t('settings.shortcuts.changeAria', { combo: text, action: label })}
            onClick={open}
          >
            <ShortcutKeys combo={combo} />
          </button>
          <IconButton
            className="settings-shortcut-row-action"
            icon={<CloseIcon size={12} />}
            label={t('settings.shortcuts.removeAria', { combo: text, action: label })}
            onClick={() => removeShortcut(action, slot)}
          />
        </div>
      )
    }

    // Só a primeira célula vazia oferece "Adicionar": a lista não tem buracos.
    if (slot !== bindings[action].length) return <span className="settings-shortcut-empty">—</span>

    return (
      <button
        type="button"
        className="settings-shortcut-add"
        data-slot={`${action}-${slot}`}
        aria-label={t('settings.shortcuts.addAria', { action: label })}
        onClick={open}
      >
        <PlusIcon size={12} />
        {t('settings.shortcuts.add')}
      </button>
    )
  }

  return (
    <div className="settings-shortcuts" data-testid="shortcut-settings">
      <p className="settings-proxy-hint">{t('settings.shortcuts.hint')}</p>
      <table ref={tableRef} className="settings-shortcuts-table">
        <thead>
          <tr>
            <th scope="col" className="settings-shortcuts-col-action">{t('settings.shortcuts.columnAction')}</th>
            <th scope="col">{t('settings.shortcuts.columnPrimary')}</th>
            <th scope="col">{t('settings.shortcuts.columnAlternative')}</th>
            <th scope="col" className="settings-shortcuts-col-options">
              <span className="settings-visually-hidden">{t('settings.shortcuts.columnOptions')}</span>
            </th>
          </tr>
        </thead>
        {SHORTCUT_GROUPS.map((group) => (
          <tbody key={group.id}>
            <tr className="settings-shortcuts-group">
              <th scope="colgroup" colSpan={4}>
                {t(`settings.shortcuts.group.${group.id}`)}
              </th>
            </tr>
            {group.actions.map((action) => (
              <tr key={action}>
                <th scope="row">{actionLabel(action)}</th>
                {SLOTS.map((slot) => (
                  <td key={slot}>{renderSlot(action, slot)}</td>
                ))}
                <td className="settings-shortcuts-col-options">
                  {!isDefaultBinding(bindings, action) && (
                    <IconButton
                      className="settings-shortcut-row-action"
                      icon={<RefreshIcon size={12} />}
                      label={t('settings.shortcuts.restoreDefaultAria', { action: actionLabel(action) })}
                      onClick={() => resetShortcut(action)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <div className="settings-proxy-actions">
        <Button variant="ghost" disabled={allDefault} onClick={resetAllShortcuts}>
          {t('settings.shortcuts.restoreAll')}
        </Button>
      </div>
      {capturing && (
        <ShortcutCaptureModal
          actionLabel={actionLabel(capturing.action)}
          acceptsMouse={isCanvasAction(capturing.action)}
          evaluate={evaluate(capturing)}
          onConfirm={(combo) => assignShortcut(capturing.action, capturing.slot, combo)}
          onClose={() => {
            setCapturing(null)
            setFocusSlot(capturing)
          }}
        />
      )}
    </div>
  )
}
