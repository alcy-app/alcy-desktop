import type { Node, NodeProps } from '@xyflow/react'
import { FlowNodeCard } from './FlowNodeCard'
import type { NodeOutput } from './FlowNodeCard'
import { LOAD_NODE_DEFINITIONS } from './load-node-config'
import type { LoadNodeKindState } from './flows.types'
import { useLanguage } from '../../shared/i18n/use-language'

export type BlockNodeType = Node<
  {
    label: string
    /** Preserva a semântica de um bloco importado de carga sem introduzir um
     * componente de canvas para cada variante. */
    loadKind?: string
    loadConfig?: string
    onOpenSettings: () => void
    onDelete: () => void
    onDuplicate: () => void
    visited?: boolean
    readOnly?: boolean
  },
  'block'
>

export function BlockNode({ data }: NodeProps<BlockNodeType>) {
  const { t } = useLanguage()
  const definition = data.loadKind ? LOAD_NODE_DEFINITIONS[data.loadKind as LoadNodeKindState] : null
  let outputs: 'single' | 'none' | NodeOutput[] = 'single'
  if (definition?.outputs === 'single' || definition?.outputs === 'none') {
    outputs = definition.outputs
  } else if (definition) {
    outputs = definition.outputs.map((id) => ({
        id,
        label: id === 'iteration' ? t('flows.canvas.loadIterationLabel') : id === 'body' ? t('flows.canvas.loadBodyLabel') : id === 'success' ? t('flows.canvas.requestSuccessLabel') : t('flows.canvas.whileDoneLabel'),
        variant: id === 'iteration' || id === 'body' ? 'loop' : id === 'success' ? 'positive' : 'neutral',
      }))
  }
  return (
    <FlowNodeCard
      kind="block"
      title={data.label || undefined}
      subtitle={definition ? t(definition.descriptionKey) : undefined}
      outputs={outputs}
      visited={data.visited}
      readOnly={data.readOnly}
      onOpenSettings={data.onOpenSettings}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
    />
  )
}
