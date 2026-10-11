import { useLanguage } from '../../shared/i18n/use-language'
import { useTooltip } from '../../shared/ui/use-tooltip'

interface DeleteNodeButtonProps {
  onDelete: () => void
}

/** Item "excluir" dentro do pill `NodeToolbar` — remove o node e suas edges
 * conectadas via `ReactFlowInstance.deleteElements` (respeita
 * `deletable: false`, então nunca afeta o node `Start`). A silhueta da
 * lixeira é desenhada em CSS (`::before`/`::after`), não com um ícone SVG —
 * mesmo motivo do "X" de `.flow-edge-delete`: SVG dentro desses botões não
 * centralizava de forma confiável neste ambiente. */
export function DeleteNodeButton({ onDelete }: DeleteNodeButtonProps) {
  const { t } = useLanguage()
  const { triggerProps, tooltip } = useTooltip(t('flows.canvas.deleteNodeAria'), { side: 'top' })

  return (
    <>
      <button
        type="button"
        className="flow-node-toolbar-button flow-node-toolbar-button--delete"
        aria-label={t('flows.canvas.deleteNodeAria')}
        {...triggerProps}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
      />
      {tooltip}
    </>
  )
}
