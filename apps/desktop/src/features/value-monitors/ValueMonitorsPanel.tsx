import { truncateMiddle } from '../../shared/truncate-middle'
import { useState } from 'react'
import type { FocusEvent } from 'react'
import type { ValueMonitorDto, ValueMonitorsError, ValueRuleKind } from '../../bindings/list-value-monitors'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { MenuItem } from '../../shared/ui/Menu'
import { AlertIcon, ChevronDownIcon, PlusIcon, TrashIcon } from '../../shared/ui/icons'
import '../../shared/ui/menu.css'
import { RuleEditor } from './RuleEditor'
import { RULE_GROUPS, describeRule, hasParameters, ruleName, type RuleKindName } from './rule-catalog'
import { TokenInput } from './TokenInput'
import './value-monitors.css'

export interface ValueMonitorsPanelProps {
  monitors: ValueMonitorDto[]
  error: ValueMonitorsError | null
  onAddMonitor: () => string
  onRemoveMonitor: (id: string) => void
  onRenameMonitor: (id: string, name: string) => void
  onSetMonitorEnabled: (id: string, enabled: boolean) => void
  onAddField: (id: string, field: string) => void
  onRemoveField: (id: string, field: string) => void
  onAddRule: (id: string, kind: RuleKindName) => string
  onUpdateRule: (id: string, ruleId: string, rule: ValueRuleKind) => void
  onRemoveRule: (id: string, ruleId: string) => void
}

export function ValueMonitorsPanel({
  monitors,
  error,
  onAddMonitor,
  onRemoveMonitor,
  onRenameMonitor,
  onSetMonitorEnabled,
  onAddField,
  onRemoveField,
  onAddRule,
  onUpdateRule,
  onRemoveRule,
}: ValueMonitorsPanelProps) {
  const { t } = useLanguage()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)

  const selected = monitors.find((monitor) => monitor.id === selectedId) ?? monitors[0] ?? null
  const pendingRemove = monitors.find((monitor) => monitor.id === pendingRemoveId) ?? null
  const invalid = error?.kind === 'invalid' ? error : null
  const monitorLabel = (monitor: ValueMonitorDto) => monitor.name.trim() || t('common.unnamed')

  const summary = (monitor: ValueMonitorDto) =>
    [
      t(monitor.fields.length === 1 ? 'monitors.fieldCountOne' : 'monitors.fieldCount', { count: monitor.fields.length }),
      t(monitor.rules.length === 1 ? 'monitors.ruleCountOne' : 'monitors.ruleCount', { count: monitor.rules.length }),
    ].join(' · ')

  return (
    <>
      {error?.kind === 'storage' && (
        <p className="env-unreadable" role="alert">
          <AlertIcon size={13} />
          <span>{t('monitors.storageError', { message: error.message })}</span>
        </p>
      )}

      {monitors.length === 0 ? (
        <p className="vm-empty">{t('monitors.empty')}</p>
      ) : (
        <ul className="env-list">
          {monitors.map((monitor) => {
            const label = monitorLabel(monitor)
            return (
              <li key={monitor.id} className="env-list-row vm-list-row">
                <button
                  type="button"
                  className="env-list-item vm-list-item"
                  aria-current={monitor.id === selected?.id}
                  onClick={() => {
                    setSelectedId(monitor.id)
                    setEditingRuleId(null)
                  }}
                >
                  <span className="vm-list-text">
                    <span className={`vm-list-name${monitor.enabled ? '' : ' vm-list-name--disabled'}`}>
                      {label}
                      {invalid?.monitorId === monitor.id && <AlertIcon size={12} className="vm-list-alert" />}
                    </span>
                    <span className="vm-list-meta">{summary(monitor)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="switch"
                  className="vm-switch"
                  aria-checked={monitor.enabled}
                  aria-label={t('monitors.enableAria', { name: label })}
                  onClick={() => onSetMonitorEnabled(monitor.id, !monitor.enabled)}
                >
                  <span className="vm-switch-thumb" aria-hidden="true" />
                </button>
                <IconButton
                  variant="danger"
                  className="vm-reveal"
                  icon={<TrashIcon size={13} />}
                  label={t('monitors.removeAria', { name: label })}
                  onClick={() => setPendingRemoveId(monitor.id)}
                />
              </li>
            )
          })}
        </ul>
      )}

      <Button
        variant="ghost"
        className="env-add-button"
        onClick={() => {
          setSelectedId(onAddMonitor())
          setEditingRuleId(null)
        }}
      >
        <PlusIcon size={12} />
        {t('monitors.addButton')}
      </Button>

      {selected && (
        <div className="env-detail vm-detail">
          <InlineEditInput
            className="vm-detail-name"
            value={selected.name}
            aria-label={t('monitors.nameAria')}
            onChange={(event) => onRenameMonitor(selected.id, event.target.value)}
          />
          {invalid?.monitorId === selected.id && invalid.ruleId === null && (
            <p className="vm-error" role="alert">
              {invalid.message}
            </p>
          )}

          <section className="vm-section" aria-labelledby="vm-fields-label">
            <h3 id="vm-fields-label" className="vm-section-label">
              {t('monitors.fieldsLabel')}
            </h3>
            <TokenInput
              mono
              tokens={selected.fields}
              placeholder={t('monitors.fieldsPlaceholder')}
              inputAriaLabel={t('monitors.fieldsAria')}
              removeAriaLabel={(field) => t('monitors.removeFieldAria', { field })}
              onAdd={(field) => onAddField(selected.id, field)}
              onRemove={(field) => onRemoveField(selected.id, field)}
            />
          </section>

          <section className="vm-section" aria-labelledby="vm-rules-label">
            <h3 id="vm-rules-label" className="vm-section-label">
              {t('monitors.rulesLabel')}
            </h3>
            {selected.rules.length === 0 ? (
              <p className="vm-muted">{t('monitors.rulesEmpty')}</p>
            ) : (
              <ul className="vm-rules">
                {selected.rules.map((rule) => {
                  const description = describeRule(rule, t)
                  const editable = hasParameters(rule.kind)
                  const editing = editable && editingRuleId === rule.id
                  const ruleError = invalid?.monitorId === selected.id && invalid.ruleId === rule.id ? invalid.message : null
                  return (
                    <li key={rule.id} className="vm-rule" data-editing={editing || undefined}>
                      <div className="vm-rule-row">
                        {editable ? (
                          <button
                            type="button"
                            className="vm-rule-summary"
                            aria-expanded={editing}
                            onClick={() => setEditingRuleId(editing ? null : rule.id)}
                          >
                            {description}
                          </button>
                        ) : (
                          <span className="vm-rule-summary vm-rule-summary--static">{description}</span>
                        )}
                        <IconButton
                          className="vm-reveal"
                          icon={<TrashIcon size={12} />}
                          label={t('monitors.removeRuleAria', { rule: description })}
                          onClick={() => onRemoveRule(selected.id, rule.id)}
                        />
                      </div>
                      {editing && (
                        <RuleEditor
                          rule={rule}
                          idPrefix={`vm-rule-${rule.id}`}
                          onChange={(next) => onUpdateRule(selected.id, rule.id, next)}
                        />
                      )}
                      {ruleError && (
                        <p className="vm-error" role="alert">
                          {ruleError}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            <AddRuleMenu
              onSelect={(kind) => {
                const ruleId = onAddRule(selected.id, kind)
                setEditingRuleId(hasParameters(kind) ? ruleId : null)
              }}
            />
          </section>
        </div>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={t('monitors.removeModalTitle')}
          description={t('monitors.removeModalDescription', { name: truncateMiddle(monitorLabel(pendingRemove)) })}
          confirmLabel={t('common.remove')}
          cancelLabel={t('common.cancel')}
          closeAriaLabel={t('collections.closeModalAria')}
          onConfirm={() => {
            onRemoveMonitor(pendingRemove.id)
            setPendingRemoveId(null)
          }}
          onCancel={() => setPendingRemoveId(null)}
        />
      )}
    </>
  )
}

/** "Adicionar regra": um único botão de texto que abre os tipos agrupados. */
function AddRuleMenu({ onSelect }: { onSelect: (kind: RuleKindName) => void }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)

  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }

  return (
    <div className="ui-menu-host vm-add-rule" onBlur={closeOnBlur}>
      <Button variant="ghost" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {t('monitors.addRule')}
        <ChevronDownIcon size={12} />
      </Button>
      {open && (
        <div
          className="ui-menu vm-rule-menu"
          role="menu"
          aria-label={t('monitors.addRule')}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
          }}
        >
          {RULE_GROUPS.map((group, index) => (
            <div key={group.label} role="group" aria-label={t(group.label)} className="vm-rule-menu-group">
              <span className="vm-rule-menu-heading" aria-hidden="true">
                {t(group.label)}
              </span>
              {group.kinds.map((kind, kindIndex) => (
                <MenuItem
                  key={kind}
                  label={ruleName(kind, t)}
                  autoFocus={index === 0 && kindIndex === 0}
                  onSelect={() => {
                    onSelect(kind)
                    setOpen(false)
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
