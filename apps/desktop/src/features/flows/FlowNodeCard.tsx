import { Handle, Position } from '@xyflow/react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Badge } from '../../shared/ui/Badge'
import { IconButton } from '../../shared/ui/IconButton'
import { AlertIcon, GearIcon } from '../../shared/ui/icons'
import type { FlowSourceHandle } from './flows.types'
import { NODE_KIND_APPEARANCE } from './node-kind-appearance'
import type { FlowNodeKind } from './node-kind-appearance'
import { describeRunStatus, runStateClass } from './node-run-status'
import { NodeToolbar } from './NodeToolbar'
import type { NodeRunStatus } from './use-flow-run'

/** Cor da saída no rodapé: verde (verdadeiro/sucesso), vermelho (falha),
 * âmbar (corpo do loop) ou neutro (falso/fim). */
export type NodeOutputVariant = 'positive' | 'negative' | 'loop' | 'neutral'

export interface NodeOutput {
  id: FlowSourceHandle
  label: string
  variant: NodeOutputVariant
}

interface FlowNodeCardProps {
  kind: FlowNodeKind
  /** Padrão: o título do tipo (`NODE_KIND_APPEARANCE`). */
  title?: string
  /** Padrão: a descrição do tipo. */
  subtitle?: string
  /** Antes do título — ex.: o método HTTP de uma requisição. */
  titleBadge?: ReactNode
  runStatus?: NodeRunStatus
  visited?: boolean
  readOnly?: boolean
  /** Cartão estreito, para nodes sem conteúdo (Start, Break, Continue). */
  compact?: boolean
  hasInput?: boolean
  /** `'single'`: uma saída sem rótulo; lista: saídas nomeadas no rodapé; `'none'`: sem saída. */
  outputs?: 'single' | 'none' | NodeOutput[]
  onOpenSettings?: () => void
  /** Ações extras no cabeçalho, antes da engrenagem. */
  headerActions?: ReactNode
  /** Linha entre o corpo e as saídas — ex.: id do node e copiar referência. */
  meta?: ReactNode
  onDuplicate?: () => void
  onDelete?: () => void
  /** Modificadores extras do cartão (ex.: requisição não configurada). */
  className?: string
  children?: ReactNode
}

/** Moldura de todo node executável do canvas (spec 0087): cabeçalho com
 * ícone da categoria, título, subtítulo e status do run; corpo com o
 * conteúdo do tipo; faixa de erro; saídas nomeadas no rodapé. A cor vem de
 * `--node-tone`, definido pela classe `flow-node--tone-*`. */
export function FlowNodeCard({
  kind,
  title,
  subtitle,
  titleBadge,
  runStatus = { status: 'idle' },
  visited,
  readOnly,
  compact,
  hasInput = true,
  outputs = 'single',
  onOpenSettings,
  headerActions,
  meta,
  onDuplicate,
  onDelete,
  className,
  children,
}: FlowNodeCardProps) {
  const { t } = useLanguage()
  const appearance = NODE_KIND_APPEARANCE[kind]
  const { Icon } = appearance
  const chip = describeRunStatus(runStatus, t)
  const resolvedTitle = title ?? t(appearance.titleKey)

  const classes = [
    'flow-node',
    `flow-node--${kind}`,
    `flow-node--tone-${appearance.tone}`,
    compact ? 'flow-node--compact' : '',
    runStateClass(runStatus, visited),
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      {hasInput && <Handle type="target" position={Position.Left} className="flow-node-handle flow-node-handle--input" />}

      <div className="flow-node-header">
        <span className="flow-node-icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <div className="flow-node-heading">
          <div className="flow-node-title-row">
            {titleBadge}
            <span className="flow-node-title" title={resolvedTitle}>
              {resolvedTitle}
            </span>
          </div>
          <span className="flow-node-subtitle">{subtitle ?? t(appearance.descriptionKey)}</span>
        </div>
        {(chip || headerActions || (onOpenSettings && !readOnly)) && (
          <div className="flow-node-header-actions">
            {chip && (
              <Badge tone={chip.tone} className="flow-node-run-chip" title={chip.detail ? `${chip.label} · ${chip.detail}` : chip.label}>
                <span className="flow-node-run-chip-label">{chip.label}</span>
                {chip.detail && <span className="flow-node-run-chip-detail">{chip.detail}</span>}
              </Badge>
            )}
            {headerActions}
            {onOpenSettings && !readOnly && (
              <span className="nodrag">
                <IconButton icon={<GearIcon size={12} />} label={t('flows.canvas.openNodeSettingsAria')} size="sm" onClick={onOpenSettings} />
              </span>
            )}
          </div>
        )}
      </div>

      {children !== undefined && children !== null && children !== false && <div className="flow-node-body">{children}</div>}

      {runStatus.status === 'failed' && (
        <div className="flow-node-error" role="status" title={runStatus.message}>
          <AlertIcon size={12} />
          <span className="flow-node-error-message">{runStatus.message}</span>
        </div>
      )}

      {meta && <div className="flow-node-meta">{meta}</div>}

      {Array.isArray(outputs) ? (
        <div className="flow-node-outputs" aria-label={t('flows.canvas.nodeOutputsLabel')}>
          {outputs.map((output) => (
            <div key={output.id} className={`flow-node-output flow-node-output--${output.variant}`}>
              <span className="flow-node-output-label">{output.label}</span>
              <Handle type="source" position={Position.Right} id={output.id} className="flow-node-handle flow-node-handle--output" />
            </div>
          ))}
        </div>
      ) : (
        outputs === 'single' && (
          <Handle type="source" position={Position.Right} className="flow-node-handle flow-node-handle--output flow-node-handle--header" />
        )
      )}

      {!readOnly && onDuplicate && onDelete && <NodeToolbar onDuplicate={onDuplicate} onDelete={onDelete} />}
    </div>
  )
}
