import type { Node, NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { ConditionView } from './ConditionView'
import type { ConditionState } from './flows.types'
import { FlowNodeCard } from './FlowNodeCard'
import type { NodeRunStatus } from './use-flow-run'

export type IfNodeType = Node<
  {
    condition: ConditionState
    runStatus: NodeRunStatus
    onOpenSettings: () => void
    onDelete: () => void
    onDuplicate: () => void
    visited?: boolean
    readOnly?: boolean
  },
  'if'
>

/** Node condicional (spec 0047): avalia `condition` em tempo de execução e
 * só o ramo correspondente roda — duas saídas nomeadas (`true`/`false`)
 * para que a edge que sai de cada uma carregue qual ramo representa
 * (`FlowEdgeState.sourceHandle`, ligado em `FlowCanvas.onConnect`/
 * `handlePaletteSelect*`). A condição em si é editada no
 * `NodeInspectorPanel`, não aqui. Novos nodes ligados a um ramo nascem
 * arrastando a conexão do handle até um espaço vazio do canvas
 * (`FlowCanvas.onConnectEnd`). */
export function IfNode({ data }: NodeProps<IfNodeType>) {
  const { t } = useLanguage()

  return (
    <FlowNodeCard
      kind="if"
      runStatus={data.runStatus}
      visited={data.visited}
      readOnly={data.readOnly}
      onOpenSettings={data.onOpenSettings}
      onDuplicate={data.onDuplicate}
      onDelete={data.onDelete}
      outputs={[
        { id: 'true', label: t('flows.canvas.ifTrueLabel'), variant: 'positive' },
        { id: 'false', label: t('flows.canvas.ifFalseLabel'), variant: 'neutral' },
      ]}
    >
      <ConditionView condition={data.condition} />
    </FlowNodeCard>
  )
}
