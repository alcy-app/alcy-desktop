import { useState } from 'react'
import type { SchemaNodeDto } from '../../../bindings/get-request-docs'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Badge } from '../../../shared/ui/Badge'
import { ChevronDownIcon, ChevronRightIcon } from '../../../shared/ui/icons'
import { resolveSchema, schemaDetails, schemaTypeLabel } from '../schema-docs'
import type { SchemaMap } from '../schema-docs'

interface SchemaTreeProps {
  node: SchemaNodeDto
  schemas: SchemaMap
  /** Nome exibido na raiz (ex.: nome do schema); sem nome, só o tipo. */
  name?: string
  /** Se a raiz começa aberta. */
  defaultExpanded?: boolean
}

/** Árvore de um schema, expandida sob demanda: referências só são abertas
 * quando o usuário expande o nó, e uma referência a um ancestral aparece
 * como recursiva em vez de se repetir. */
export function SchemaTree({ node, schemas, name, defaultExpanded = true }: SchemaTreeProps) {
  return (
    <ul className="docs-schema-tree" role="tree">
      <SchemaNodeRow
        label={name ?? null}
        node={node}
        schemas={schemas}
        required={false}
        ancestors={[]}
        defaultExpanded={defaultExpanded}
      />
    </ul>
  )
}

interface ChildEntry {
  key: string
  label: string | null
  node: SchemaNodeDto
  required: boolean
  /** Grupo de composição (`allOf`/`oneOf`/`anyOf`) ou `items`. */
  group?: string
}

function childrenOf(resolved: SchemaNodeDto, groupLabels: Record<'allOf' | 'oneOf' | 'anyOf' | 'items' | 'additional', string>): ChildEntry[] {
  const children: ChildEntry[] = resolved.properties.map((property) => ({
    key: `property:${property.name}`,
    label: property.name,
    node: property.schema,
    required: resolved.required.includes(property.name),
  }))
  if (resolved.items) {
    children.push({ key: 'items', label: null, node: resolved.items, required: false, group: groupLabels.items })
  }
  if (resolved.additionalProperties) {
    children.push({
      key: 'additional',
      label: null,
      node: resolved.additionalProperties,
      required: false,
      group: groupLabels.additional,
    })
  }
  for (const kind of ['allOf', 'oneOf', 'anyOf'] as const) {
    resolved[kind].forEach((variant, index) => {
      children.push({ key: `${kind}:${index}`, label: null, node: variant, required: false, group: groupLabels[kind] })
    })
  }
  return children
}

function SchemaNodeRow({
  label,
  node,
  schemas,
  required,
  ancestors,
  defaultExpanded,
  group,
}: {
  label: string | null
  node: SchemaNodeDto
  schemas: SchemaMap
  required: boolean
  ancestors: string[]
  defaultExpanded: boolean
  group?: string
}) {
  const { t } = useLanguage()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const recursive = node.refName !== null && ancestors.includes(node.refName)
  const resolved = recursive ? null : resolveSchema(node, schemas)
  const unresolved = node.refName !== null && !recursive && resolved === null
  const children = resolved
    ? childrenOf(resolved, {
        allOf: t('docs.allOf'),
        oneOf: t('docs.oneOf'),
        anyOf: t('docs.anyOf'),
        items: t('docs.items'),
        additional: t('docs.additionalProperties'),
      })
    : []
  const expandable = children.length > 0
  // Descrição do uso (irmã do `$ref`) tem prioridade sobre a do schema.
  const description = node.description || resolved?.description || ''
  const nextAncestors = node.refName !== null ? [...ancestors, node.refName] : ancestors
  const details = resolved ? schemaDetails(resolved, t) : []

  return (
    <li className="docs-schema-node" role="treeitem" aria-expanded={expandable ? expanded : undefined}>
      <div className="docs-schema-row">
        {expandable ? (
          <button
            type="button"
            className="docs-schema-toggle"
            aria-label={expanded ? t('docs.collapse') : t('docs.expand')}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </button>
        ) : (
          <span className="docs-schema-toggle-spacer" aria-hidden="true" />
        )}
        {group && <span className="docs-schema-group">{group}</span>}
        {label !== null && <span className="docs-schema-name">{label}</span>}
        <span className="docs-schema-type">{schemaTypeLabel(node)}</span>
        {required && (
          <span className="docs-required" title={t('docs.required')}>
            *
          </span>
        )}
        {resolved?.readOnly && <Badge className="docs-badge">{t('docs.readOnly')}</Badge>}
        {resolved?.writeOnly && <Badge className="docs-badge">{t('docs.writeOnly')}</Badge>}
        {(node.deprecated || resolved?.deprecated) && (
          <Badge tone="warning" className="docs-badge">
            {t('common.deprecated')}
          </Badge>
        )}
        {recursive && <span className="docs-schema-note">{t('docs.recursive')}</span>}
        {unresolved && <span className="docs-schema-note">{t('docs.unresolved')}</span>}
      </div>
      {(description || details.length > 0) && (
        <div className="docs-schema-info">
          {description && <p className="docs-description">{description}</p>}
          {details.map((detail) => (
            <p key={detail} className="docs-schema-detail">
              {detail}
            </p>
          ))}
        </div>
      )}
      {expandable && expanded && (
        <ul className="docs-schema-children" role="group">
          {children.map((child) => (
            <SchemaNodeRow
              key={child.key}
              label={child.label}
              node={child.node}
              schemas={schemas}
              required={child.required}
              ancestors={nextAncestors}
              defaultExpanded={false}
              group={child.group}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
