import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentModelDto } from '../../bindings/agent-settings'
import { useLanguage } from '../../shared/i18n/use-language'
import { Input } from '../../shared/ui/Input'
import { CheckIcon, ChevronDownIcon, RefreshIcon, Spinner } from '../../shared/ui/icons'

interface ModelComboboxProps {
  value: string
  onChange: (value: string) => void
  /** Models the provider listed; empty until they are loaded. */
  models: AgentModelDto[]
  loading: boolean
  /** Loading needs the saved settings; `false` while there are unsaved edits. */
  canLoad: boolean
  onLoad: () => void
  label: string
  placeholder: string
}

/**
 * Model field: free text, with the provider's models in a list styled like
 * the app's menus. Typing filters the list; arrows, Enter and Escape work as
 * in any combobox.
 */
export function ModelCombobox({ value, onChange, models, loading, canLoad, onLoad, label, placeholder }: ModelComboboxProps) {
  const { t } = useLanguage()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  // Filter only by what the user types; a value picked from the list shows all models again.
  const [query, setQuery] = useState<string | null>(null)

  const needle = (query ?? '').trim().toLowerCase()
  const options = needle === '' ? models : models.filter((model) => `${model.id} ${model.label}`.toLowerCase().includes(needle))
  const active = options[Math.min(highlight, options.length - 1)]

  const choose = (model: AgentModelDto) => {
    onChange(model.id)
    setQuery(null)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (options.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((index) => (Math.min(index, options.length - 1) + step + options.length) % options.length)
      return
    }
    if (event.key === 'Enter' && open && active) {
      event.preventDefault()
      choose(active)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="settings-model-combobox" data-open={open}>
      <div className="settings-model-combobox-field">
        <Input
          ref={inputRef}
          mono
          className="settings-model-combobox-input"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && active ? `${listId}-${options.indexOf(active)}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false)
            setQuery(null)
          }}
          onChange={(event) => {
            onChange(event.target.value)
            setQuery(event.target.value)
            setHighlight(0)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="settings-model-combobox-toggle"
          tabIndex={-1}
          aria-label={t('settings.agent.modelsToggle')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            inputRef.current?.focus()
            setOpen((current) => !current)
          }}
        >
          <ChevronDownIcon size={12} />
        </button>
      </div>

      {open && (
        <div className="ui-menu settings-model-combobox-menu" onMouseDown={(event) => event.preventDefault()}>
          {loading ? (
            <p className="settings-model-combobox-note">
              <Spinner size={12} />
              {t('settings.agent.modelsLoading')}
            </p>
          ) : models.length === 0 ? (
            <div className="settings-model-combobox-note">
              <span>{canLoad ? t('settings.agent.modelsEmpty') : t('settings.agent.modelsAfterSave')}</span>
              {canLoad && (
                <button type="button" className="settings-model-combobox-load" onClick={onLoad}>
                  <RefreshIcon size={12} />
                  {t('settings.agent.loadModels')}
                </button>
              )}
            </div>
          ) : options.length === 0 ? (
            <p className="settings-model-combobox-note">{t('settings.agent.modelsNoMatch')}</p>
          ) : (
            <ul id={listId} role="listbox" aria-label={label} className="settings-model-combobox-list">
              {options.map((model, index) => {
                const selected = model.id === value
                return (
                  <li
                    key={model.id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={model === active}
                    data-selected={selected}
                    className="settings-model-combobox-option"
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(model)}
                  >
                    <span className="settings-model-combobox-check" aria-hidden="true">{selected && <CheckIcon size={12} />}</span>
                    <span className="settings-model-combobox-id">{model.id}</span>
                    {model.label !== model.id && <span className="settings-model-combobox-label">{model.label}</span>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
