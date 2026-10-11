import { useMemo, useState } from 'react'
import type { SchemaDirective, SchemaInputValue, SchemaType } from '../../../bindings/load-schema'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { Button } from '../../../shared/ui/Button'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { Input } from '../../../shared/ui/Input'
import { Spinner } from '../../../shared/ui/icons'
import { describeSchemaError, schemaErrorDetail } from '../schema-error-messages'
import { FailureMessage } from './FailureMessage'
import type { SchemaLoadState } from '../request-workbench.types'
import './schema-panel.css'

interface SchemaPanelProps {
  schema: SchemaLoadState
  onLoad: (forceRefresh: boolean) => void
  onCancel: () => void
}

type SchemaListEntry = { kind: 'type'; type: SchemaType } | { kind: 'directive'; directive: SchemaDirective }

function formatArg(arg: SchemaInputValue): string {
  const defaultPart = arg.defaultValue !== null ? ` = ${arg.defaultValue}` : ''
  return `${arg.name}: ${arg.typeDisplay}${defaultPart}`
}

function formatArgs(args: SchemaInputValue[]): string {
  if (args.length === 0) return ''
  return `(${args.map(formatArg).join(', ')})`
}

function typeMatchesSearch(type: SchemaType, term: string): boolean {
  if (!term) return true
  if (type.name.toLowerCase().includes(term)) return true
  return type.fields.some((field) => field.name.toLowerCase().includes(term))
}

function entryName(entry: SchemaListEntry): string {
  return entry.kind === 'type' ? entry.type.name : `@${entry.directive.name}`
}

function entryMatchesSearch(entry: SchemaListEntry, search: string): boolean {
  const term = search.trim().toLowerCase()
  if (!term) return true
  if (entry.kind === 'type') return typeMatchesSearch(entry.type, term)
  return entry.directive.name.toLowerCase().includes(term)
}

function TypeRefLink({ display, name, onSelect }: { display: string; name: string | null; onSelect: (name: string) => void }) {
  if (!name) return <span>{display}</span>
  return (
    <button type="button" className="schema-type-link" onClick={() => onSelect(name)}>
      {display}
    </button>
  )
}

function DeprecatedBadge({ reason }: { reason: string | null }) {
  const { t } = useLanguage()
  return (
    <Badge tone="warning" className="schema-deprecated-badge" title={reason ?? t('common.deprecatedTitle')}>
      {t('common.deprecated')}
    </Badge>
  )
}

function TypeNameList({
  title,
  names,
  onSelect,
}: {
  title: string
  names: string[]
  onSelect: (name: string) => void
}) {
  if (names.length === 0) return null
  return (
    <p className="schema-type-relations">
      {title}:{' '}
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && ', '}
          <button type="button" className="schema-type-link" onClick={() => onSelect(name)}>
            {name}
          </button>
        </span>
      ))}
    </p>
  )
}

export function SchemaPanel({ schema, onLoad, onCancel }: SchemaPanelProps) {
  const { t } = useLanguage()
  const [search, setSearch] = useState('')
  const [selectedName, setSelectedName] = useState<string | null>(null)

  const types = schema.status === 'success' ? schema.schema.types : []
  const directives = schema.status === 'success' ? schema.schema.directives : []

  const filteredEntries = useMemo(() => {
    const currentTypes = schema.status === 'success' ? schema.schema.types : []
    const currentDirectives = schema.status === 'success' ? schema.schema.directives : []
    const entries: SchemaListEntry[] = [
      ...currentTypes.map((type): SchemaListEntry => ({ kind: 'type', type })),
      ...currentDirectives.map((directive): SchemaListEntry => ({ kind: 'directive', directive })),
    ]
    return entries
      .filter((entry) => entryMatchesSearch(entry, search))
      .sort((a, b) => entryName(a).localeCompare(entryName(b)))
  }, [schema, search])

  const selectedType =
    types.find((type) => type.name === selectedName) ??
    (schema.status === 'success' && !selectedName?.startsWith('@')
      ? types.find((type) => type.name === schema.schema.queryType)
      : undefined)
  const selectedDirective = selectedName?.startsWith('@')
    ? directives.find((directive) => `@${directive.name}` === selectedName)
    : undefined
  const hasSelection = Boolean(selectedType || selectedDirective || filteredEntries[0])

  if (schema.status === 'idle') {
    return (
      <div className="rw-panel schema-panel">
        <EmptyState
          title={t('schema.loadPrompt')}
          action={
            <Button variant="ghost" onClick={() => onLoad(false)}>
              {t('schema.loadButton')}
            </Button>
          }
        />
      </div>
    )
  }

  if (schema.status === 'loading') {
    return (
      <div className="rw-panel schema-panel">
        <p className="rw-status-message rw-status-message--row">
          <Spinner size={12} />
          {t('schema.loading')}
        </p>
        <button type="button" className="rw-link-button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    )
  }

  if (schema.status === 'error') {
    return (
      <div className="rw-panel schema-panel">
        <FailureMessage summary={describeSchemaError(t, schema.error)} detail={schemaErrorDetail(schema.error)} />
        <Button variant="ghost" onClick={() => onLoad(false)}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  const fallbackEntry = filteredEntries[0]
  const displayEntry: SchemaListEntry | undefined = selectedType
    ? { kind: 'type', type: selectedType }
    : selectedDirective
      ? { kind: 'directive', directive: selectedDirective }
      : fallbackEntry

  return (
    <div className="rw-panel schema-panel schema-panel--loaded">
      <div className="schema-toolbar">
        <label className="rw-visually-hidden" htmlFor="schema-search">
          {t('schema.searchLabel')}
        </label>
        <Input
          id="schema-search"
          type="search"
          placeholder={t('schema.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button variant="ghost" onClick={() => onLoad(true)}>
          {t('schema.refreshButton')}
        </Button>
      </div>

      <div className="schema-explorer">
        {filteredEntries.length === 0 ? (
          <p className="rw-status-message">{t('schema.noResults')}</p>
        ) : (
          <ul className="schema-type-list" aria-label={t('schema.typesListLabel')}>
            {filteredEntries.map((entry) => {
              const name = entryName(entry)
              const isActive = displayEntry ? entryName(displayEntry) === name : false
              return (
                <li key={name}>
                  <button
                    type="button"
                    className={`schema-type-item${isActive ? ' schema-type-item--active' : ''}`}
                    onClick={() => setSelectedName(name)}
                  >
                    {entry.kind === 'type' ? (
                      <>
                        <span className="schema-type-kind">{entry.type.kind}</span> {entry.type.name}
                        {entry.type.name === schema.schema.queryType && (
                          <Badge tone="accent" className="schema-type-badge">
                            Query
                          </Badge>
                        )}
                        {entry.type.name === schema.schema.mutationType && (
                          <Badge tone="accent" className="schema-type-badge">
                            Mutation
                          </Badge>
                        )}
                        {entry.type.name === schema.schema.subscriptionType && (
                          <Badge tone="accent" className="schema-type-badge">
                            Subscription
                          </Badge>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="schema-type-kind">DIRECTIVE</span> @{entry.directive.name}
                      </>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="schema-type-detail">
          {!hasSelection && <p className="rw-status-message">{t('schema.selectPrompt')}</p>}

          {displayEntry?.kind === 'type' && (
            <>
              <h3 className="schema-type-title">
                {displayEntry.type.name} <span className="schema-type-kind">{displayEntry.type.kind}</span>
              </h3>
              {displayEntry.type.description && <p className="schema-type-description">{displayEntry.type.description}</p>}

              <TypeNameList title={t('schema.implements')} names={displayEntry.type.interfaces} onSelect={setSelectedName} />
              <TypeNameList
                title={t('schema.possibleTypes')}
                names={displayEntry.type.possibleTypes}
                onSelect={setSelectedName}
              />

              {displayEntry.type.fields.length > 0 && (
                <ul className="schema-field-list">
                  {displayEntry.type.fields.map((field) => (
                    <li key={field.name} className="schema-field">
                      <p className="schema-field-signature">
                        <span className="schema-field-name">{field.name}</span>
                        {formatArgs(field.args)}:{' '}
                        <TypeRefLink display={field.typeDisplay} name={field.typeName} onSelect={setSelectedName} />
                        {field.isDeprecated && <DeprecatedBadge reason={field.deprecationReason} />}
                      </p>
                      {field.description && <p className="schema-field-description">{field.description}</p>}
                    </li>
                  ))}
                </ul>
              )}

              {displayEntry.type.enumValues.length > 0 && (
                <ul className="schema-field-list">
                  {displayEntry.type.enumValues.map((value) => (
                    <li key={value.name} className="schema-field">
                      <p className="schema-field-signature">
                        {value.name}
                        {value.isDeprecated && <DeprecatedBadge reason={value.deprecationReason} />}
                      </p>
                      {value.description && <p className="schema-field-description">{value.description}</p>}
                    </li>
                  ))}
                </ul>
              )}

              {displayEntry.type.inputFields.length > 0 && (
                <ul className="schema-field-list">
                  {displayEntry.type.inputFields.map((field) => (
                    <li key={field.name} className="schema-field">
                      <p className="schema-field-signature">
                        <span className="schema-field-name">{field.name}</span>:{' '}
                        <TypeRefLink display={field.typeDisplay} name={field.typeName} onSelect={setSelectedName} />
                        {field.defaultValue !== null && ` = ${field.defaultValue}`}
                      </p>
                      {field.description && <p className="schema-field-description">{field.description}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {displayEntry?.kind === 'directive' && (
            <>
              <h3 className="schema-type-title">
                @{displayEntry.directive.name} <span className="schema-type-kind">DIRECTIVE</span>
              </h3>
              {displayEntry.directive.description && (
                <p className="schema-type-description">{displayEntry.directive.description}</p>
              )}
              <p className="schema-type-relations">
                {t('schema.locations', { locations: displayEntry.directive.locations.join(', ') })}
              </p>

              {displayEntry.directive.args.length > 0 && (
                <ul className="schema-field-list">
                  {displayEntry.directive.args.map((arg) => (
                    <li key={arg.name} className="schema-field">
                      <p className="schema-field-signature">
                        <span className="schema-field-name">{arg.name}</span>:{' '}
                        <TypeRefLink display={arg.typeDisplay} name={arg.typeName} onSelect={setSelectedName} />
                        {arg.defaultValue !== null && ` = ${arg.defaultValue}`}
                      </p>
                      {arg.description && <p className="schema-field-description">{arg.description}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
