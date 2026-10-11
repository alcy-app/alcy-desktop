import { createPortal } from 'react-dom'
import './drag-preview.css'

interface DragPreviewProps {
  label: string | null
  position: { x: number; y: number } | null
}

/** Rótulo flutuante que segue o cursor durante um arraste (`use-pointer-drag`),
 * para deixar claro o que está sendo movido e onde o cursor está. */
export function DragPreview({ label, position }: DragPreviewProps) {
  if (!label || !position) return null

  return createPortal(
    <div className="drag-preview" style={{ left: position.x, top: position.y }} aria-hidden="true">
      {label}
    </div>,
    document.body,
  )
}
