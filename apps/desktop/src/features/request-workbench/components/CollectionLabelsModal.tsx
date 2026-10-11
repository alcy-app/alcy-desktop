import { useId, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CollectionLabelDto, LabelColor } from '../../../bindings/list-collections'
import { useLanguage } from '../../../shared/i18n/use-language'
import type { TranslationKey } from '../../../shared/i18n/translations'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { IconButton } from '../../../shared/ui/IconButton'
import { Input } from '../../../shared/ui/Input'
import { Modal } from '../../../shared/ui/Modal'
import { CheckIcon, CloseIcon, PencilIcon, TrashIcon } from '../../../shared/ui/icons'
import { LABEL_COLORS, LABEL_NAME_MAX_LENGTH, labelKey } from '../collection-labels'
import './collection-labels.css'

const COLOR_KEYS: Record<LabelColor, TranslationKey> = {
  gray: 'collections.labels.color.gray',
  red: 'collections.labels.color.red',
  orange: 'collections.labels.color.orange',
  yellow: 'collections.labels.color.yellow',
  green: 'collections.labels.color.green',
  teal: 'collections.labels.color.teal',
  blue: 'collections.labels.color.blue',
  purple: 'collections.labels.color.purple',
  pink: 'collections.labels.color.pink',
}

export function LabelDot({ color }: { color: LabelColor }) {
  return <span className="collection-label-dot" data-label-color={color} aria-hidden="true" />
}

/** Seletor de cor da paleta fixa, como um grupo de rádios. */
function LabelColorPicker({
  value,
  onChange,
  label,
  inline = false,
}: {
  value: LabelColor
  onChange: (color: LabelColor) => void
  label: string
  inline?: boolean
}) {
  const { t } = useLanguage()
  return (
    <div
      className={inline ? 'collection-labels-palette collection-labels-palette--inline' : 'collection-labels-palette'}
      role="radiogroup"
      aria-label={label}
    >
      {LABEL_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(COLOR_KEYS[color])}
          title={t(COLOR_KEYS[color])}
          className="collection-labels-swatch"
          data-label-color={color}
          onClick={() => onChange(color)}
        >
          {value === color && !inline && <CheckIcon size={10} />}
        </button>
      ))}
    </div>
  )
}

/** Marcado quando todas as collections-alvo têm o rótulo, parcial quando só algumas têm. Marcar
 * um parcial liga o rótulo em todas. */
function LabelCheckbox({
  assignedCount,
  total,
  onChange,
}: {
  assignedCount: number
  total: number
  onChange: (assigned: boolean) => void
}) {
  const all = assignedCount === total
  const partial = assignedCount > 0 && !all
  return (
    <Checkbox
      ref={(input) => {
        if (input) input.indeterminate = partial
      }}
      checked={all}
      onChange={() => onChange(!all)}
    />
  )
}

interface CollectionLabelsModalProps {
  /** Rótulos do workspace (`labelCatalog`). */
  catalog: CollectionLabelDto[]
  /** Quantas collections usam cada rótulo, por `labelKey`. */
  usage: ReadonlyMap<string, number>
  /** Collections cujos rótulos são marcados — uma, ou a seleção múltipla; sem elas, o modal só
   * gerencia o catálogo. `title` já vem traduzido. */
  targets?: { title: string; labelSets: CollectionLabelDto[][] }
  /** Liga (`assigned`) ou desliga o rótulo em todas as collections de `targets`. */
  onAssign?: (label: CollectionLabelDto, assigned: boolean) => void
  onRename: (oldName: string, newName: string) => void
  onRecolor: (name: string, color: LabelColor) => void
  onRemove: (name: string) => void
  onClose: () => void
}

/** Atribui rótulos a uma ou mais collections e gerencia o catálogo (renomear, trocar a cor, excluir de todas). */
export function CollectionLabelsModal({
  catalog,
  usage,
  targets,
  onAssign,
  onRename,
  onRecolor,
  onRemove,
  onClose,
}: CollectionLabelsModalProps) {
  const { t } = useLanguage()
  const newNameId = useId()
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<LabelColor>('blue')
  const [editing, setEditing] = useState<{ key: string; name: string; color: LabelColor } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<CollectionLabelDto | null>(null)

  const assigning = targets !== undefined && onAssign !== undefined
  const targetCount = targets?.labelSets.length ?? 0
  /** Em quantas das collections-alvo cada rótulo já está, por `labelKey`. */
  const assignedCounts = new Map<string, number>()
  for (const labels of targets?.labelSets ?? []) {
    for (const label of labels) {
      const key = labelKey(label.name)
      assignedCounts.set(key, (assignedCounts.get(key) ?? 0) + 1)
    }
  }
  const assignedToAll = (key: string) => targetCount > 0 && assignedCounts.get(key) === targetCount
  const trimmedNewName = newName.trim()
  const existingForNewName = catalog.find((label) => labelKey(label.name) === labelKey(trimmedNewName))
  const newNameAlreadyAssigned = existingForNewName !== undefined && assignedToAll(labelKey(trimmedNewName))

  const addLabel = () => {
    if (!trimmedNewName || newNameAlreadyAssigned || !onAssign) return
    // Um nome que já existe no catálogo reaproveita o rótulo (e a cor) existente.
    onAssign(existingForNewName ?? { name: trimmedNewName, color: newColor }, true)
    setNewName('')
  }

  const commitEdit = () => {
    if (!editing) return
    const original = catalog.find((label) => labelKey(label.name) === editing.key)
    const name = editing.name.trim()
    if (original && name) {
      if (editing.color !== original.color) onRecolor(original.name, editing.color)
      if (name !== original.name) onRename(original.name, name)
    }
    setEditing(null)
  }

  const handleEditKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitEdit()
  }

  return (
    <>
      <Modal
        title={targets ? targets.title : t('collections.labels.manageTitle')}
        closeAriaLabel={t('collections.closeModalAria')}
        onClose={onClose}
        // Com um rótulo em edição, o Escape cancela só a edição, sem fechar o modal.
        onEscape={editing ? () => setEditing(null) : undefined}
        className="ui-modal--form collection-labels-modal"
      >
        {(requestClose) => (
          <>
            <p className="collection-labels-hint">
              {targets
                ? t(targetCount > 1 ? 'collections.labels.assignManyHint' : 'collections.labels.assignHint')
                : t('collections.labels.manageHint')}
            </p>

            {catalog.length === 0 ? (
              <p className="collection-labels-empty">{t('collections.labels.emptyCatalog')}</p>
            ) : (
              <ul className="collection-labels-list" aria-label={t('collections.labels.listAria')}>
                {catalog.map((label) => {
                  const key = labelKey(label.name)
                  const count = usage.get(key) ?? 0
                  if (editing?.key === key) {
                    return (
                      <li key={key} className="collection-labels-row">
                        <LabelDot color={editing.color} />
                        <Input
                          className="collection-labels-row-input"
                          value={editing.name}
                          autoFocus
                          maxLength={LABEL_NAME_MAX_LENGTH}
                          aria-label={t('collections.labels.nameAria')}
                          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                          onKeyDown={handleEditKeyDown}
                        />
                        <LabelColorPicker
                          inline
                          label={t('collections.labels.editColorAria', { name: label.name })}
                          value={editing.color}
                          onChange={(color) => setEditing({ ...editing, color })}
                        />
                        <IconButton
                          icon={<CheckIcon size={12} />}
                          label={t('collections.labels.saveEditAria')}
                          disabled={!editing.name.trim()}
                          onClick={commitEdit}
                        />
                        <IconButton icon={<CloseIcon size={11} />} label={t('common.cancel')} onClick={() => setEditing(null)} />
                      </li>
                    )
                  }
                  return (
                    <li key={key} className="collection-labels-row" data-label-color={label.color}>
                      {assigning ? (
                        <label className="collection-labels-row-toggle">
                          <LabelCheckbox
                            assignedCount={assignedCounts.get(key) ?? 0}
                            total={targetCount}
                            onChange={(assigned) => onAssign(label, assigned)}
                          />
                          <LabelDot color={label.color} />
                          <span className="collection-labels-row-name" title={label.name}>{label.name}</span>
                        </label>
                      ) : (
                        <span className="collection-labels-row-toggle">
                          <LabelDot color={label.color} />
                          <span className="collection-labels-row-name" title={label.name}>{label.name}</span>
                        </span>
                      )}
                      <span className="collection-labels-row-count">
                        {count === 1 ? t('collections.labels.usageOne') : t('collections.labels.usage', { count })}
                      </span>
                      <IconButton
                        icon={<PencilIcon size={12} />}
                        label={t('collections.labels.editAria', { name: label.name })}
                        onClick={() => setEditing({ key, name: label.name, color: label.color })}
                      />
                      <IconButton
                        icon={<TrashIcon size={12} />}
                        variant="danger"
                        label={t('collections.labels.removeAria', { name: label.name })}
                        onClick={() => setPendingRemove(label)}
                      />
                    </li>
                  )
                })}
              </ul>
            )}

            {assigning && (
              <div className="collection-labels-form">
                <label className="collection-labels-form-title" htmlFor={newNameId}>
                  {t('collections.labels.newTitle')}
                </label>
                <div className="collection-labels-form-row">
                  <Input
                    id={newNameId}
                    value={newName}
                    maxLength={LABEL_NAME_MAX_LENGTH}
                    placeholder={t('collections.labels.newPlaceholder')}
                    onChange={(event) => setNewName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      addLabel()
                    }}
                  />
                  <Button variant="primary" size="sm" disabled={!trimmedNewName || newNameAlreadyAssigned} onClick={addLabel}>
                    {t('collections.labels.addButton')}
                  </Button>
                </div>
                {existingForNewName ? (
                  <p className="collection-labels-hint">
                    {newNameAlreadyAssigned
                      ? t('collections.labels.alreadyAssigned', { name: existingForNewName.name })
                      : t('collections.labels.reuseExisting', { name: existingForNewName.name })}
                  </p>
                ) : (
                  <LabelColorPicker label={t('collections.labels.colorAria')} value={newColor} onChange={setNewColor} />
                )}
              </div>
            )}

            <div className="ui-modal-actions">
              <Button variant="ghost" onClick={requestClose}>
                {t('common.close')}
              </Button>
            </div>
          </>
        )}
      </Modal>

      {pendingRemove && (
        <ConfirmDialog
          title={t('collections.labels.removeTitle')}
          description={t('collections.labels.removeDescription', {
            name: pendingRemove.name,
            count: usage.get(labelKey(pendingRemove.name)) ?? 0,
          })}
          confirmLabel={t('common.remove')}
          cancelLabel={t('common.cancel')}
          closeAriaLabel={t('collections.closeModalAria')}
          onConfirm={() => {
            onRemove(pendingRemove.name)
            setPendingRemove(null)
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </>
  )
}
