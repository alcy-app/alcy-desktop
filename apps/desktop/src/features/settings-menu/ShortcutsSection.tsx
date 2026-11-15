import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import {
  findConflict,
  isCanvasAction,
  isDefaultBinding,
  DEFAULT_SHORTCUTS,
  assignShortcut as assignBinding,
  removeShortcut as removeBinding,
  sameCombo,
  SHORTCUT_ACTIONS,
  validateCombo,
  type KeyCombo,
  type ShortcutAction,
} from '../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../shared/shortcuts/use-shortcuts'
import { useSettingsAction } from './settings-actions'
import { IconButton } from '../../shared/ui/IconButton'
import { Input } from '../../shared/ui/Input'
import { CloseIcon, PlusIcon, SearchIcon } from '../../shared/ui/icons'
import { ShortcutCaptureModal, type CaptureEvaluation } from './ShortcutCaptureModal'
import { ShortcutKeys } from './ShortcutKeys'
import { formatComboForDisplay } from './shortcut-display'
import { SHORTCUT_GROUPS } from './shortcut-groups'
import { normalizeSearch } from './settings-navigation'

interface SlotRef {
  action: ShortcutAction
  slot: number
}

const SLOTS = [0, 1] as const

export function ShortcutsSection() {
  const { t } = useLanguage()
  const { bindings: savedBindings, applyBindings } = useShortcuts()
  const [bindings, setBindings] = useState(savedBindings)
  const assignShortcut = (action: ShortcutAction, slot: number, combo: KeyCombo) => setBindings((current) => assignBinding(current, action, slot, combo))
  const removeShortcut = (action: ShortcutAction, slot: number) => setBindings((current) => removeBinding(current, action, slot))
  const [capturing, setCapturing] = useState<SlotRef | null>(null)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // Return focus to the edited slot, or to search if its new binding no longer matches.
  const [focusSlot, setFocusSlot] = useState<SlotRef | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)

  useEffect(() => {
    if (!focusSlot) return
    const slot = tableRef.current?.querySelector<HTMLButtonElement>(`[data-slot="${focusSlot.action}-${focusSlot.slot}"]`)
    ;(slot ?? searchRef.current)?.focus()
  }, [focusSlot])

  const actionLabel = (action: ShortcutAction) => t(`settings.shortcuts.action.${action}`)
  const allDefault = SHORTCUT_ACTIONS.every((action) => isDefaultBinding(bindings, action))
  useSettingsAction({
    dirty: JSON.stringify(bindings) !== JSON.stringify(savedBindings),
    isDefault: allDefault,
    blocked: capturing !== null,
    apply: () => applyBindings(bindings),
    restore: () => setBindings(DEFAULT_SHORTCUTS),
  })
  const terms = normalizeSearch(query).replace(/\s*\+\s*/g, '+').split(/\s+/).filter(Boolean)
  const groups = SHORTCUT_GROUPS.map((group) => ({
    ...group,
    actions: group.actions.filter((action) => {
      const combos = bindings[action].map((combo) => normalizeSearch(formatComboForDisplay(combo, t)))
      const text = normalizeSearch([
        actionLabel(action),
        t(`settings.shortcuts.group.${group.id}`),
        ...combos,
      ].join(' '))
      return terms.every((term) => term.includes('+')
        ? combos.some((combo) => combo === term || combo.startsWith(`${term} `))
        : text.includes(term))
    }),
  })).filter((group) => group.actions.length > 0)

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

    // Only the first empty slot offers Add: bindings have no gaps.
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
      <div className="settings-search settings-shortcuts-search" onKeyDown={(event) => {
        if (event.key === 'Escape' && query) {
          event.stopPropagation()
          setQuery('')
          searchRef.current?.focus()
        }
      }}>
        <SearchIcon size={14} />
        <Input ref={searchRef} type="search" value={query} aria-label={t('settings.shortcuts.search')} placeholder={t('settings.shortcuts.search')} onChange={(event) => setQuery(event.target.value)} />
        {query && <IconButton icon={<CloseIcon size={12} />} label={t('settings.searchClear')} onClick={() => { setQuery(''); searchRef.current?.focus() }} />}
      </div>
      {groups.length === 0 ? <p className="settings-proxy-hint" role="status">{t('settings.shortcuts.searchEmpty')}</p> : <table ref={tableRef} className="settings-shortcuts-table">
        <thead>
          <tr>
            <th scope="col" className="settings-shortcuts-col-action">{t('settings.shortcuts.columnAction')}</th>
            <th scope="col">{t('settings.shortcuts.columnPrimary')}</th>
            <th scope="col">{t('settings.shortcuts.columnAlternative')}</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.id}>
            <tr className="settings-shortcuts-group">
              <th scope="colgroup" colSpan={3}>
                {t(`settings.shortcuts.group.${group.id}`)}
              </th>
            </tr>
            {group.actions.map((action) => (
              <tr key={action}>
                <th scope="row">{actionLabel(action)}</th>
                {SLOTS.map((slot) => (
                  <td key={slot}>{renderSlot(action, slot)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>}
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
