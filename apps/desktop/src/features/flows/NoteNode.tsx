import { useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { NodeToolbar } from './NodeToolbar'
import type { SimpleFlowNodeType } from './simple-node-types'

const MIN_WIDTH = 140
const MIN_HEIGHT = 70

/** Anotação livre no canvas (spec 0083): sem handles, não executa e não
 * aparece no log. Fora da edição, o texto é só exibição e a nota inteira
 * arrasta; clique duplo abre a edição (um `textarea` com `nodrag`), que
 * termina ao sair do campo ou com Esc. O tamanho muda pelas alças do
 * `NodeResizer` quando selecionada. */
export function NoteNode({ data, selected }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  const [editing, setEditing] = useState(false)
  const { config } = data
  if (config.kind !== 'note') return null

  const isEditing = editing && !data.readOnly

  return (
    <div
      className="flow-node flow-node--note flow-node--tone-note"
      onDoubleClick={() => {
        if (!data.readOnly) setEditing(true)
      }}
    >
      {!data.readOnly && <NodeResizer isVisible={selected} minWidth={MIN_WIDTH} minHeight={MIN_HEIGHT} />}
      {isEditing ? (
        <textarea
          className="flow-note-text nodrag nowheel"
          value={config.text}
          placeholder={t('flows.canvas.notePlaceholder')}
          aria-label={t('flows.canvas.noteTextAria')}
          autoFocus
          onFocus={(event) => {
            const end = event.currentTarget.value.length
            event.currentTarget.setSelectionRange(end, end)
          }}
          onChange={(event) => data.onConfigChange({ ...config, text: event.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
        />
      ) : (
        <div className={config.text ? 'flow-note-text' : 'flow-note-text flow-note-text--empty'}>
          {config.text || (data.readOnly ? '' : t('flows.canvas.noteEmptyHint'))}
        </div>
      )}
      {!data.readOnly && <NodeToolbar onDuplicate={data.onDuplicate} onDelete={data.onDelete} />}
    </div>
  )
}
