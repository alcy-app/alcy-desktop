import { DeleteNodeButton } from './DeleteNodeButton'
import { DuplicateNodeButton } from './DuplicateNodeButton'

interface NodeToolbarProps {
  onDuplicate: () => void
  onDelete: () => void
}

/** Pill flutuante acima do node reunindo
 * as ações rápidas num único contêiner, em vez de botões soltos — visível
 * só quando o node está selecionado (`.selected`, aplicado pelo próprio
 * xyflow ao clicar) **e** o mouse está em cima dele ao mesmo tempo (ver
 * seletor em `flow-canvas.css`, encadeando `.selected` no ancestral com
 * `:hover` no `.flow-node`). */
export function NodeToolbar({ onDuplicate, onDelete }: NodeToolbarProps) {
  return (
    <div className="flow-node-toolbar">
      <DuplicateNodeButton onDuplicate={onDuplicate} />
      <span className="flow-node-toolbar-divider" aria-hidden="true" />
      <DeleteNodeButton onDelete={onDelete} />
    </div>
  )
}
