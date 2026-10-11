import { useDeferredValue, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SchemaField, SchemaInputValue, SchemaType } from '../../../bindings/load-schema'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { EmptyState } from '../../../shared/ui/EmptyState'
import { IconButton } from '../../../shared/ui/IconButton'
import { ChevronRightIcon, CloseIcon, RefreshIcon, SearchIcon, Spinner } from '../../../shared/ui/icons'
import { useTooltip } from '../../../shared/ui/use-tooltip'
import { createEmptyQuery, getArgValue, isFieldSelected, parseQuery } from '../graphql-query-tree'
import type { ParsedQuery } from '../graphql-query-tree'
import { fieldKey, searchQueryExplorerFields } from '../query-explorer-search'
import type { QueryExplorerSearchResult } from '../query-explorer-search'
import { describeSchemaError, schemaErrorDetail } from '../schema-error-messages'
import { FailureMessage } from './FailureMessage'
import { displayArgumentValue, fieldHasSubfields, formatArgumentValue, rootTypeNameFor, typeIndexOf } from '../schema-helpers'
import type { SchemaLoadState } from '../request-workbench.types'
import './query-explorer.css'

type ToggleField = (path: string[], fieldName: string, hasSubfields: boolean) => void
type SetArgument = (path: string[], fieldName: string, hasSubfields: boolean, argName: string, literal: string | null) => void

interface QueryExplorerProps {
  query: string
  schema: SchemaLoadState
  onToggleField: ToggleField
  onSetArgument: SetArgument
  onLoad: (forceRefresh: boolean) => void
  onCancel: () => void
}

export function QueryExplorer({ query, schema, onToggleField, onSetArgument, onLoad, onCancel }: QueryExplorerProps) {
  const { t } = useLanguage()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const closeSearch = () => {
    setSearch('')
    setSearchOpen(false)
  }
  const deferredSearch = useDeferredValue(search)
  const parsed = useMemo(() => parseQuery(query) ?? createEmptyQuery(), [query])
  const operationType = parsed.operationType
  const rootTypeName = schema.status === 'success' ? rootTypeNameFor(operationType, schema.schema) : null
  const rootType = useMemo(
    () => (schema.status === 'success' && rootTypeName !== null ? typeIndexOf(schema.schema.types).get(rootTypeName) : undefined),
    [schema, rootTypeName],
  )
  const searchResult = useMemo(
    () =>
      rootType && schema.status === 'success'
        ? searchQueryExplorerFields(rootType, schema.schema.types, deferredSearch)
        : null,
    [rootType, schema, deferredSearch],
  )

  // Durante a busca, os ancestrais dos campos encontrados abrem sozinhos; o
  // usuário ainda pode recolhê-los, sem perder a expansão feita fora da busca.
  const [syncedSearchResult, setSyncedSearchResult] = useState(searchResult)
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set(searchResult?.expanded))
  if (searchResult !== syncedSearchResult) {
    setSyncedSearchResult(searchResult)
    setSearchExpanded(new Set(searchResult?.expanded))
  }

  const toggleExpanded = (nodeKey: string) => {
    const setter = searchResult ? setSearchExpanded : setExpanded
    setter((current) => {
      const next = new Set(current)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
      return next
    })
  }
  const currentExpanded = searchResult ? searchExpanded : expanded

  if (schema.status === 'idle') {
    return (
      <div className="query-explorer">
        <EmptyState
          title={t('queryExplorer.loadPrompt')}
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
      <div className="query-explorer">
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
      <div className="query-explorer">
        <FailureMessage summary={describeSchemaError(t, schema.error)} detail={schemaErrorDetail(schema.error)} />
        <Button variant="ghost" onClick={() => onLoad(false)}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  const types = schema.schema.types
  const rootFields = rootType
    ? rootType.fields.filter((field) => !searchResult || searchResult.visible.has(field.name))
    : []

  return (
    <div className="query-explorer query-explorer--loaded">
      <div className="query-explorer-toolbar">
        {searchOpen ? (
          <div className="query-explorer-search">
            <SearchIcon size={12} className="query-explorer-search-icon" />
            <input
              type="text"
              className="query-explorer-search-input"
              value={search}
              autoFocus
              placeholder={t('queryExplorer.searchPlaceholder')}
              aria-label={t('queryExplorer.searchLabel')}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  closeSearch()
                }
              }}
            />
            <IconButton
              className="query-explorer-search-close"
              icon={<CloseIcon size={13} />}
              label={t('queryExplorer.searchCloseAria')}
              onClick={closeSearch}
            />
          </div>
        ) : (
          <>
            <p className="query-explorer-title">{t('queryExplorer.title')}</p>
            <div className="query-explorer-actions">
              {rootType && rootType.fields.length > 0 && (
                <IconButton
                  icon={<SearchIcon size={12} />}
                  label={t('queryExplorer.searchLabel')}
                  onClick={() => setSearchOpen(true)}
                />
              )}
              <IconButton
                icon={<RefreshIcon size={13} />}
                label={t('queryExplorer.refreshButton')}
                onClick={() => onLoad(true)}
              />
            </div>
          </>
        )}
      </div>

      <div className="query-explorer-scroll">
        {!rootTypeName && (
          <p className="rw-status-message">
            {t('queryExplorer.missingRootType', {
              operationType: operationType === 'mutation' ? 'Mutation' : operationType === 'subscription' ? 'Subscription' : 'Query',
            })}
          </p>
        )}

        {rootTypeName && !rootType && <p className="rw-status-message">{t('queryExplorer.typeNotFound')}</p>}

        {rootType && rootType.fields.length === 0 && <p className="rw-status-message">{t('queryExplorer.noFields')}</p>}

        {searchResult && searchResult.matchCount === 0 && (
          <p className="rw-status-message">{t('queryExplorer.searchNoResults', { term: deferredSearch.trim() })}</p>
        )}

        {searchResult?.truncated && (
          <p className="rw-status-message">{t('queryExplorer.searchTruncated', { count: searchResult.matchCount })}</p>
        )}

        {rootFields.length > 0 && (
          <ul className="query-explorer-tree" aria-label={t('queryExplorer.fieldsListLabel')}>
            {rootFields.map((field) => (
              <FieldNode
                key={field.name}
                field={field}
                path={[]}
                types={types}
                parsed={parsed}
                expanded={currentExpanded}
                search={searchResult}
                onToggleExpanded={toggleExpanded}
                onToggleField={onToggleField}
                onSetArgument={onSetArgument}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Destaca no nome do campo o trecho que casa com a busca. */
function highlightMatch(name: string, term: string | undefined): ReactNode {
  if (!term) return name
  const start = name.toLowerCase().indexOf(term)
  if (start < 0) return name
  const end = start + term.length
  return (
    <>
      {name.slice(0, start)}
      <mark className="query-explorer-match">{name.slice(start, end)}</mark>
      {name.slice(end)}
    </>
  )
}

interface FieldNodeProps {
  field: SchemaField
  path: string[]
  types: SchemaType[]
  parsed: ParsedQuery
  expanded: Set<string>
  search: QueryExplorerSearchResult | null
  onToggleExpanded: (key: string) => void
  onToggleField: ToggleField
  onSetArgument: SetArgument
}

/** Nó recursivo da árvore: uma linha (checkbox + nome + tipo) e, se expandido, seus argumentos e subcampos. */
function FieldNode({
  field,
  path,
  types,
  parsed,
  expanded,
  search,
  onToggleExpanded,
  onToggleField,
  onSetArgument,
}: FieldNodeProps) {
  const { t } = useLanguage()
  const fieldPath = [...path, field.name]
  const pathLabel = fieldPath.join(' > ')
  const key = fieldKey(fieldPath)
  const isExpanded = expanded.has(key)
  const expandLabel = isExpanded
    ? t('queryExplorer.collapseFieldAria', { field: pathLabel })
    : t('queryExplorer.expandFieldAria', { field: pathLabel })
  const expandTooltip = useTooltip(expandLabel)
  const hasSubfields = fieldHasSubfields(field, types)
  const hasArgs = field.args.length > 0
  const canExpand = hasSubfields || hasArgs
  const selected = isFieldSelected(parsed, path, field.name)
  const childType = hasSubfields && field.typeName ? typeIndexOf(types).get(field.typeName) : undefined
  // Num ancestral de campo encontrado, só os filhos do caminho aparecem; um
  // campo aberto à mão (fora do caminho) mostra todos os seus filhos.
  const childFields = search?.expanded.has(key)
    ? (childType?.fields.filter((childField) => search.visible.has(fieldKey([...fieldPath, childField.name]))) ?? [])
    : (childType?.fields ?? [])

  return (
    <li className="query-explorer-node">
      <div className="query-explorer-row">
        {canExpand ? (
          <>
            <button
              type="button"
              className="query-explorer-expand"
              aria-expanded={isExpanded}
              aria-label={expandLabel}
              {...expandTooltip.triggerProps}
              onClick={() => onToggleExpanded(key)}
            >
              <ChevronRightIcon
                size={10}
                className={isExpanded ? 'query-explorer-chevron query-explorer-chevron--expanded' : 'query-explorer-chevron'}
              />
            </button>
            {expandTooltip.tooltip}
          </>
        ) : (
          <span className="query-explorer-expand-spacer" aria-hidden="true" />
        )}
        <Checkbox
          checked={selected}
          aria-label={t('queryExplorer.addFieldAria', { field: pathLabel })}
          onChange={() => onToggleField(path, field.name, hasSubfields)}
        />
        <button
          type="button"
          className="query-explorer-field-name"
          title={field.description ?? undefined}
          disabled={!canExpand}
          onClick={() => canExpand && onToggleExpanded(key)}
        >
          {highlightMatch(field.name, search?.term)}
        </button>
        {field.isDeprecated && (
          <Badge tone="warning" className="query-explorer-deprecated" title={field.deprecationReason ?? undefined}>
            {t('common.deprecated')}
          </Badge>
        )}
        <span className="query-explorer-field-type">{field.typeDisplay}</span>
      </div>

      {isExpanded && (
        <ul className="query-explorer-children">
          {field.args.map((arg) => (
            <ArgRow
              key={arg.name}
              arg={arg}
              field={field}
              path={path}
              pathLabel={pathLabel}
              parsed={parsed}
              hasSubfields={hasSubfields}
              onSetArgument={onSetArgument}
            />
          ))}
          {childFields.map((childField) => (
            <FieldNode
              key={childField.name}
              field={childField}
              path={fieldPath}
              types={types}
              parsed={parsed}
              expanded={expanded}
              search={search}
              onToggleExpanded={onToggleExpanded}
              onToggleField={onToggleField}
              onSetArgument={onSetArgument}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

interface ArgRowProps {
  arg: SchemaInputValue
  field: SchemaField
  path: string[]
  pathLabel: string
  parsed: ParsedQuery
  hasSubfields: boolean
  onSetArgument: SetArgument
}

function ArgRow({ arg, field, path, pathLabel, parsed, hasSubfields, onSetArgument }: ArgRowProps) {
  const { t } = useLanguage()
  const inputRef = useRef<HTMLInputElement>(null)
  const displayValue = displayArgumentValue(getArgValue(parsed, path, field.name, arg.name))
  const [syncedValue, setSyncedValue] = useState(displayValue)
  const [value, setValue] = useState(displayValue)
  if (displayValue !== syncedValue) {
    setSyncedValue(displayValue)
    setValue(displayValue)
  }

  const commit = (nextValue: string) => {
    setValue(nextValue)
    const literal = nextValue.trim().length === 0 ? null : formatArgumentValue(nextValue, arg)
    onSetArgument(path, field.name, hasSubfields, arg.name, literal)
  }

  const included = displayValue.length > 0

  const handleToggle = () => {
    if (included) {
      commit('')
      return
    }
    if (arg.defaultValue) {
      commit(displayArgumentValue(arg.defaultValue))
    } else {
      inputRef.current?.focus()
    }
  }

  return (
    <li className="query-explorer-arg-row">
      <Checkbox
        checked={included}
        aria-label={t('queryExplorer.includeArgAria', { arg: arg.name, field: pathLabel })}
        onChange={handleToggle}
      />
      <span className="query-explorer-arg-name">{arg.name}</span>
      <input
        ref={inputRef}
        type="text"
        className="query-explorer-arg-input"
        value={value}
        placeholder={arg.defaultValue ?? undefined}
        aria-label={t('queryExplorer.argValueAria', { arg: arg.name, field: pathLabel })}
        onChange={(event) => commit(event.target.value)}
      />
      <span className="query-explorer-arg-badge">ARG</span>
      <span className="query-explorer-arg-type">{arg.typeDisplay}</span>
    </li>
  )
}
