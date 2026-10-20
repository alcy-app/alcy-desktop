import { useState } from 'react'
import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useLanguage } from '../../shared/i18n/use-language'
import { OverlayMotionContext } from '../../shared/ui/overlay-motion-context'
import { MenuItem, OptionsMenu } from '../../shared/ui/Menu'
import type { SimpleFlowNodeType } from './simple-node-types'
import { FlowNodeSurface } from './FlowNodeSurface'

const MIN_WIDTH = 140
const MIN_HEIGHT = 70

/** A resizable canvas annotation with no handles or execution. Double-click edits its text;
 * blur or Escape returns to dragging the entire note (spec 0083). */
export function NoteNode({ data, selected, width, height }: NodeProps<SimpleFlowNodeType>) {
  const { t } = useLanguage()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { config } = data
  if (config.kind !== 'note') return null

  const isEditing = editing && !data.readOnly
  const size = { width: width ?? config.width, height: height ?? config.height }
  const resizer = !data.readOnly && <NodeResizer isVisible={selected} minWidth={MIN_WIDTH} minHeight={MIN_HEIGHT} />
  const edit = () => { if (!data.readOnly) setEditing(true) }

  return (
    <OverlayMotionContext value={false}><FlowNodeSurface size={size} handles={resizer} onDoubleClick={edit}><div
      style={size}
      className="flow-node flow-node--note flow-node--tone-note"
      onDoubleClick={edit}
    >
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
      {!data.readOnly && <div className="flow-note-actions nodrag nopan" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <OptionsMenu label={t('flows.canvas.nodeActions')} isOpen={menuOpen} onToggle={() => setMenuOpen(!menuOpen)} onClose={() => setMenuOpen(false)} menuPortal menuPlacement="auto">
          <MenuItem label={t('flows.canvas.duplicateNodeAria')} onSelect={() => { setMenuOpen(false); data.onDuplicate() }} />
          <MenuItem label={t('flows.canvas.deleteNodeAria')} danger onSelect={() => { setMenuOpen(false); data.onDelete() }} />
        </OptionsMenu>
      </div>}
    </div></FlowNodeSurface></OverlayMotionContext>
  )
}
