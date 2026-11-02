import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { parseBulk, serializeBulk, type BulkRow } from '../../shared/bulk-edit'
import { useLanguage } from '../../shared/i18n/use-language'
import { comboFromEvent, isShortcutFor } from '../../shared/shortcuts/shortcuts'
import { useShortcuts } from '../../shared/shortcuts/use-shortcuts'
import { BulkEditor } from '../../shared/ui/BulkEditor'
import { BulkEditToggle } from '../../shared/ui/BulkEditToggle'
import { Checkbox } from '../../shared/ui/Checkbox'
import { EmptyState } from '../../shared/ui/EmptyState'
import { IconButton } from '../../shared/ui/IconButton'
import { InlineEditInput } from '../../shared/ui/InlineEditInput'
import { Input } from '../../shared/ui/Input'
import { Button } from '../../shared/ui/Button'
import {
  AlertIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  GripIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '../../shared/ui/icons'
import { MenuItem, OptionsMenu } from '../../shared/ui/Menu'
import { MentionInChatMenuItem } from '../agent/MentionInChatMenuItem'
import { Tooltip } from '../../shared/ui/Tooltip'
import { DragPreview } from '../../shared/DragPreview'
import { usePointerDrag } from '../../shared/use-pointer-drag'
import type { SiblingEdge } from '../../shared/use-pointer-drag'
import { SENSITIVE_MASK, type EnvironmentState, type VariableRow } from './environments.types'
import { RemoveEnvironmentModal } from './RemoveEnvironmentModal'
import { filterVariables, normalizeVariableQuery } from './filter-variables'
import { isReorderKey, keyboardMove } from './reorder'
import './environments.css'

interface EnvironmentsPanelProps {
  environments: EnvironmentState[]
  /** Variáveis sensíveis cujo valor cifrado não pôde ser lido nesta máquina. */
  unreadableSecrets?: string[]
  activeEnvironmentId: string | null
  onSelectEnvironment: (id: string) => void
  onAddEnvironment: () => void
  onRemoveEnvironment: (id: string) => void
  onDuplicateEnvironment: (id: string) => void
  onRenameEnvironment: (id: string, name: string) => void
  onMoveEnvironment: (draggedId: string, targetId: string, edge: SiblingEdge) => void
  onAddVariable: (environmentId: string) => void
  onUpdateVariable: (environmentId: string, variableId: string, patch: Partial<Omit<VariableRow, 'id'>>) => void
  onRemoveVariable: (environmentId: string, variableId: string) => void
  onMoveVariable: (environmentId: string, draggedId: string, targetId: string, edge: SiblingEdge) => void
  onReplaceVariables: (environmentId: string, rows: BulkRow[]) => void
}

type ReorderKind = 'environment' | 'variable'

const REORDER_KEYSHORTCUTS = 'ArrowUp ArrowDown Home End'

interface ReorderHandleProps {
  kind: ReorderKind
  id: string
  label: string
  hint: string
  disabled: boolean
  /** Id of an element explaining why the handle is disabled, for assistive technology. */
  describedBy?: string
  onPointerDown: (event: PointerEvent) => void
  onKeyDown: (event: KeyboardEvent) => void
}

/** Alça de reordenação: arrastar com o mouse ou, com foco, usar ↑/↓/Home/End. */
function ReorderHandle({ kind, id, label, hint, disabled, describedBy, onPointerDown, onKeyDown }: ReorderHandleProps) {
  return (
    <Tooltip label={hint} className="env-grip-host">
      <IconButton
        className="env-grip"
        icon={<GripIcon size={13} />}
        label={label}
        tooltip={false}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-keyshortcuts={REORDER_KEYSHORTCUTS}
        data-env-grip={`${kind}:${id}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || disabled) return
          onPointerDown(event)
        }}
        onKeyDown={(event) => {
          if (disabled) return
          onKeyDown(event)
        }}
      />
    </Tooltip>
  )
}

export function EnvironmentsPanel({
  environments,
  unreadableSecrets = [],
  activeEnvironmentId,
  onSelectEnvironment,
  onAddEnvironment,
  onRemoveEnvironment,
  onDuplicateEnvironment,
  onRenameEnvironment,
  onMoveEnvironment,
  onAddVariable,
  onUpdateVariable,
  onRemoveVariable,
  onMoveVariable,
  onReplaceVariables,
}: EnvironmentsPanelProps) {
  const { t } = useLanguage()
  const { bindings: shortcutBindings } = useShortcuts()
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  // Rascunho da edição em massa, atrelado ao ambiente em que foi aberto: trocar de ambiente volta à tabela.
  const [bulk, setBulk] = useState<{ environmentId: string; text: string } | null>(null)
  // Anúncio para leitores de tela após mover pelo teclado (o arraste já é visual).
  const [announcement, setAnnouncement] = useState('')
  // Alça que deve recuperar o foco depois de mover pelo teclado: ao reordenar, o React pode
  // reinserir o nó da linha no DOM, e o navegador tira o foco de um nó reinserido.
  const pendingFocusRef = useRef<string | null>(null)
  // Variable search, scoped to the environment it was typed in. `keepIds` are rows edited while filtering: they
  // stay visible until the query changes, so a row does not vanish mid-typing once it stops matching.
  const [search, setSearch] = useState<{ environmentId: string; query: string; keepIds: ReadonlySet<string> } | null>(
    null,
  )
  const searchInputRef = useRef<HTMLInputElement>(null)
  const reorderDisabledHintId = useId()

  // Switching to another environment (here or from elsewhere in the app) starts with an empty search.
  if (search !== null && search.environmentId !== activeEnvironmentId) setSearch(null)

  const activeEnvironment = environments.find((environment) => environment.id === activeEnvironmentId) ?? null
  const searchQuery = search?.query ?? ''
  const isFiltering = normalizeVariableQuery(searchQuery) !== ''
  const visibleVariables = activeEnvironment
    ? filterVariables(activeEnvironment.variables, searchQuery, search?.keepIds)
    : []

  const { draggedId, draggedKind, draggedLabel, dragOverId, dragOverKind, dragOverEdge, position, startDrag } =
    usePointerDrag<ReorderKind>({
      dropTargetAttribute: 'data-env-drop-id',
      dropKindAttribute: 'data-env-drop-kind',
      onDrop: (dragged, target, edge) => {
        // Só reordena entre irmãos do mesmo tipo: ambiente sobre ambiente, variável sobre variável.
        if (dragged.kind !== target.kind || edge === 'inside') return
        if (dragged.kind === 'environment') {
          onMoveEnvironment(dragged.id, target.id, edge)
        } else if (activeEnvironment) {
          onMoveVariable(activeEnvironment.id, dragged.id, target.id, edge)
        }
      },
    })

  useLayoutEffect(() => {
    const key = pendingFocusRef.current
    if (key === null) return
    pendingFocusRef.current = null
    const grip = Array.from(document.querySelectorAll<HTMLElement>('[data-env-grip]')).find(
      (element) => element.dataset.envGrip === key,
    )
    // Só devolve o foco se ele foi perdido na reinserção — nunca o tira de outro campo.
    const focusLost = document.activeElement === null || document.activeElement === document.body
    if (grip && focusLost) grip.focus()
  }, [environments])

  /** Classes de estado de arraste de uma linha: a própria linha sendo arrastada ou o alvo da soltura. */
  const dragClasses = (kind: ReorderKind, id: string, base: string) => {
    const classes = [base]
    if (draggedKind === kind && draggedId === id) classes.push(`${base}--dragging`)
    if (draggedKind === kind && dragOverKind === kind && dragOverId === id && dragOverEdge) {
      classes.push(`${base}--drop-${dragOverEdge}`)
    }
    return classes.join(' ')
  }

  const handleReorderKey = (
    event: KeyboardEvent,
    kind: ReorderKind,
    ids: string[],
    id: string,
    name: string,
    move: (targetId: string, edge: SiblingEdge) => void,
  ) => {
    if (!isReorderKey(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    const step = keyboardMove(ids, id, event.key)
    if (step === null) return
    pendingFocusRef.current = `${kind}:${id}`
    move(step.targetId, step.edge)
    setAnnouncement(
      t('environments.movedAnnouncement', { name, position: String(step.position), total: String(ids.length) }),
    )
  }

  const toggleRevealed = (variableId: string) => {
    setRevealed((current) => {
      const next = new Set(current)
      if (next.has(variableId)) {
        next.delete(variableId)
      } else {
        next.add(variableId)
      }
      return next
    })
  }

  /** Edits always target the variable id; while filtering, the edited row is pinned visible (see `keepIds`). */
  const updateVariable = (environmentId: string, variableId: string, patch: Partial<Omit<VariableRow, 'id'>>) => {
    if (isFiltering) {
      setSearch((current) =>
        current === null || current.keepIds.has(variableId)
          ? current
          : { ...current, keepIds: new Set(current.keepIds).add(variableId) },
      )
    }
    onUpdateVariable(environmentId, variableId, patch)
  }

  const clearSearch = (environmentId: string) => setSearch({ environmentId, query: '', keepIds: new Set() })

  const environmentIds = environments.map((environment) => environment.id)
  const variableIds = activeEnvironment?.variables.map((variable) => variable.id) ?? []
  const bulkText = bulk !== null && bulk.environmentId === activeEnvironmentId ? bulk.text : null
  const pendingRemoveEnvironment = environments.find((environment) => environment.id === pendingRemoveId) ?? null

  return (
    <>
      {unreadableSecrets.length > 0 && (
        <p className="env-unreadable" role="status">
          <AlertIcon size={13} />
          <span>{t('environments.unreadableSecrets', { names: unreadableSecrets.join(', ') })}</span>
        </p>
      )}
      <div className="rw-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <ul className="env-list">
        {environments.map((environment) => {
          const isActive = environment.id === activeEnvironmentId
          const isRenaming = environment.id === renamingId
          const label = environment.name || t('common.unnamed')
          return (
            <li
              key={environment.id}
              className={dragClasses('environment', environment.id, 'env-list-row')}
              data-env-drop-id={environment.id}
              data-env-drop-kind="environment"
              onContextMenu={(event) => {
                // While renaming, keep the native menu for the text field.
                if (isRenaming) return
                event.preventDefault()
                setMenuOpenId(environment.id)
              }}
            >
              <ReorderHandle
                kind="environment"
                id={environment.id}
                label={t('environments.reorderEnvironmentAria', { name: label })}
                hint={t('environments.reorderHint')}
                disabled={environments.length <= 1}
                onPointerDown={(event) => startDrag(environment.id, 'environment', label, event)}
                onKeyDown={(event) =>
                  handleReorderKey(event, 'environment', environmentIds, environment.id, label, (targetId, edge) =>
                    onMoveEnvironment(environment.id, targetId, edge),
                  )
                }
              />
              {/* Nome e menu formam um bloco só: o fundo de hover/ativo cobre também o "⋯". */}
              <div className={`env-list-entry${isActive ? ' env-list-entry--active' : ''}`}>
                {isRenaming ? (
                  // Fora de um <button>: clicar num input aninhado em botão move o foco para o botão e encerra a edição.
                  <div className="env-list-item env-list-item--renaming" aria-current={isActive}>
                    <span className={`env-dot${isActive ? ' env-dot--active' : ''}`} aria-hidden="true" />
                    <InlineEditInput
                      value={environment.name}
                      autoFocus
                      aria-label={t('environments.nameInputAria')}
                      onChange={(event) => onRenameEnvironment(environment.id, event.target.value)}
                      onBlur={() => setRenamingId(null)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') setRenamingId(null)
                      }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="env-list-item"
                    aria-current={isActive}
                    onClick={() => onSelectEnvironment(environment.id)}
                    onKeyDown={(event) => {
                      const combo = comboFromEvent(event)
                      if (isShortcutFor(shortcutBindings, 'renameItem', combo)) {
                        event.preventDefault()
                        setRenamingId(environment.id)
                      } else if (isShortcutFor(shortcutBindings, 'deleteItem', combo)) {
                        event.preventDefault()
                        // The last environment cannot be removed, matching the disabled menu item.
                        if (environments.length > 1) setPendingRemoveId(environment.id)
                      }
                    }}
                  >
                    <span className={`env-dot${isActive ? ' env-dot--active' : ''}`} aria-hidden="true" />
                    <span className="env-list-item-name">{label}</span>
                    {isActive && (
                      <>
                        {' '}
                        <span className="env-list-item-status">{t('environments.activeStatus')}</span>
                      </>
                    )}
                  </button>
                )}
                <OptionsMenu
                  label={t('environments.moreOptionsAria', { name: label })}
                  wrapperClassName="env-menu-wrapper"
                  menuPlacement="auto"
                  // Portal menus close on an outside click, which the right-click opening needs:
                  // focus never enters an inline menu opened that way, so blur would not close it.
                  menuPortal
                  isOpen={menuOpenId === environment.id}
                  onToggle={() => setMenuOpenId((current) => (current === environment.id ? null : environment.id))}
                  onClose={() => setMenuOpenId(null)}
                >
                  <MenuItem
                    label={t('environments.renameMenuItem')}
                    shortcutAction="renameItem"
                    onSelect={() => {
                      setRenamingId(environment.id)
                      setMenuOpenId(null)
                    }}
                  />
                  <MenuItem
                    label={t('environments.duplicateMenuItem')}
                    onSelect={() => {
                      onDuplicateEnvironment(environment.id)
                      setMenuOpenId(null)
                    }}
                  />
                  <MentionInChatMenuItem item={{ kind: 'environment', id: environment.id, label }} onDone={() => setMenuOpenId(null)} />
                  <MenuItem
                    label={t('common.remove')}
                    shortcutAction="deleteItem"
                    danger
                    disabled={environments.length <= 1}
                    onSelect={() => {
                      setPendingRemoveId(environment.id)
                      setMenuOpenId(null)
                    }}
                  />
                </OptionsMenu>
              </div>
            </li>
          )
        })}
      </ul>

      <Button variant="ghost" className="env-add-button" onClick={onAddEnvironment}>
        <PlusIcon size={12} />
        {t('environments.addButton')}
      </Button>

      {activeEnvironment && (
        <div className="env-detail">
          <p className="env-detail-title">{activeEnvironment.name || t('common.unnamed')}</p>

          <BulkEditToggle
            bulk={bulkText !== null}
            onChange={(enter) => {
              // Bulk editing always covers every variable: the search does not apply there, so it is dropped.
              setSearch(null)
              setBulk(
                enter
                  ? {
                      environmentId: activeEnvironment.id,
                      text: serializeBulk(
                        activeEnvironment.variables.map((variable) => ({
                          name: variable.name,
                          value: variable.sensitive && variable.value !== '' ? SENSITIVE_MASK : variable.value,
                        })),
                      ),
                    }
                  : null,
              )
            }}
          />

          {bulkText === null && (activeEnvironment.variables.length > 0 || search !== null) && (
            <div className="env-search">
              <SearchIcon size={12} className="env-search-icon" />
              <Input
                ref={searchInputRef}
                type="text"
                className="env-search-input"
                value={searchQuery}
                placeholder={t('environments.searchPlaceholder')}
                aria-label={t('environments.searchAria')}
                onChange={(event) =>
                  setSearch({ environmentId: activeEnvironment.id, query: event.target.value, keepIds: new Set() })
                }
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || searchQuery === '') return
                  // Consumed here so Esc only clears the field and does not also close an enclosing surface.
                  event.preventDefault()
                  event.stopPropagation()
                  clearSearch(activeEnvironment.id)
                }}
              />
              {searchQuery !== '' && (
                <IconButton
                  className="env-search-clear"
                  icon={<CloseIcon size={11} />}
                  label={t('environments.searchClearAria')}
                  onClick={() => {
                    clearSearch(activeEnvironment.id)
                    searchInputRef.current?.focus()
                  }}
                />
              )}
            </div>
          )}

          {bulkText !== null ? (
            <BulkEditor
              value={bulkText}
              ariaLabel={t('bulk.variablesAria')}
              supportsDisabled={false}
              onChange={(text) => {
                setBulk({ environmentId: activeEnvironment.id, text })
                onReplaceVariables(activeEnvironment.id, parseBulk(text, { allowDisabled: false }))
              }}
            />
          ) : (
            <>
              <span id={reorderDisabledHintId} hidden>
                {t('environments.reorderDisabledWhileSearching')}
              </span>
              {isFiltering && visibleVariables.length === 0 ? (
                <div role="status">
                  <EmptyState icon={<SearchIcon size={22} />} title={t('environments.searchEmptyState')} />
                </div>
              ) : (
                <table className="env-variables-table">
                  <caption className="rw-visually-hidden">{t('environments.variablesCaption', { name: activeEnvironment.name })}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="env-grip-cell">
                        <span className="rw-visually-hidden">{t('environments.orderColumn')}</span>
                      </th>
                      <th scope="col">{t('environments.variableColumn')}</th>
                      <th scope="col">{t('common.value')}</th>
                      <th scope="col">{t('environments.sensitiveColumn')}</th>
                      <th scope="col">
                        <span className="rw-visually-hidden">{t('common.remove')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVariables.map((variable) => {
                      const isRevealed = revealed.has(variable.id)
                      const variableLabel = variable.name || t('environments.variableFallback')
                      return (
                        <tr
                          key={variable.id}
                          className={dragClasses('variable', variable.id, 'env-variable-row')}
                          data-env-drop-id={variable.id}
                          data-env-drop-kind="variable"
                        >
                          <td className="env-grip-cell">
                            <ReorderHandle
                              kind="variable"
                              id={variable.id}
                              label={t('environments.reorderVariableAria', { name: variableLabel })}
                              // Reordering a filtered subset would be ambiguous: it is disabled until the search is cleared.
                              hint={
                                isFiltering ? t('environments.reorderDisabledWhileSearching') : t('environments.reorderHint')
                              }
                              disabled={isFiltering || activeEnvironment.variables.length <= 1}
                              describedBy={isFiltering ? reorderDisabledHintId : undefined}
                              onPointerDown={(event) => startDrag(variable.id, 'variable', variableLabel, event)}
                              onKeyDown={(event) =>
                                handleReorderKey(event, 'variable', variableIds, variable.id, variableLabel, (targetId, edge) =>
                                  onMoveVariable(activeEnvironment.id, variable.id, targetId, edge),
                                )
                              }
                            />
                          </td>
                          <td>
                            <label className="rw-visually-hidden" htmlFor={`env-var-name-${variable.id}`}>
                              {t('environments.variableNameLabel')}
                            </label>
                            <InlineEditInput
                              id={`env-var-name-${variable.id}`}
                              value={variable.name}
                              onChange={(event) =>
                                updateVariable(activeEnvironment.id, variable.id, { name: event.target.value })
                              }
                              placeholder={t('environments.namePlaceholder')}
                            />
                          </td>
                          <td>
                            <label className="rw-visually-hidden" htmlFor={`env-var-value-${variable.id}`}>
                              {t('environments.variableValueLabel')}
                            </label>
                            <div className="env-variable-value-cell">
                              <InlineEditInput
                                id={`env-var-value-${variable.id}`}
                                type={variable.sensitive && !isRevealed ? 'password' : 'text'}
                                value={variable.value}
                                onChange={(event) =>
                                  updateVariable(activeEnvironment.id, variable.id, { value: event.target.value })
                                }
                                placeholder={t('environments.valuePlaceholder')}
                              />
                              {variable.sensitive && (
                                <Tooltip label={isRevealed ? t('environments.hide') : t('environments.reveal')}>
                                  <IconButton
                                    icon={isRevealed ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                                    label={`${isRevealed ? t('environments.hide') : t('environments.reveal')} ${t('environments.revealAria', {
                                      name: variable.name || t('environments.variableFallback'),
                                    })}`}
                                    onClick={() => toggleRevealed(variable.id)}
                                    tooltip={false}
                                  />
                                </Tooltip>
                              )}
                            </div>
                          </td>
                          <td>
                            <label className="rw-visually-hidden" htmlFor={`env-var-sensitive-${variable.id}`}>
                              {t('environments.sensitiveCheckboxLabel', {
                                name: variable.name || t('environments.variableFallback'),
                              })}
                            </label>
                            <Checkbox
                              id={`env-var-sensitive-${variable.id}`}
                              checked={variable.sensitive}
                              onChange={(event) =>
                                updateVariable(activeEnvironment.id, variable.id, { sensitive: event.target.checked })
                              }
                            />
                          </td>
                          <td>
                            <IconButton
                              icon={<TrashIcon size={13} />}
                              label={t('environments.removeVariableAria', { name: variable.name || t('common.unnamed') })}
                              onClick={() => onRemoveVariable(activeEnvironment.id, variable.id)}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}

              <Button
                variant="ghost"
                onClick={() => {
                  // The new row starts blank and would never match: clearing the search keeps it in view.
                  if (search !== null) clearSearch(activeEnvironment.id)
                  onAddVariable(activeEnvironment.id)
                }}
              >
                <PlusIcon size={12} />
                {t('environments.addVariableButton')}
              </Button>
            </>
          )}
        </div>
      )}

      <DragPreview label={draggedLabel} position={position} />

      {pendingRemoveEnvironment && (
        <RemoveEnvironmentModal
          name={pendingRemoveEnvironment.name || t('common.unnamed')}
          onRemove={() => {
            onRemoveEnvironment(pendingRemoveEnvironment.id)
            setPendingRemoveId(null)
          }}
          onCancel={() => setPendingRemoveId(null)}
        />
      )}
    </>
  )
}
