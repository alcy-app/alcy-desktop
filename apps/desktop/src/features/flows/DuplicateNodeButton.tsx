import { useLanguage } from '../../shared/i18n/use-language'
import { useTooltip } from '../../shared/ui/use-tooltip'

interface DuplicateNodeButtonProps {
  onDuplicate: () => void
}

/** Item "duplicar" dentro do pill `NodeToolbar`, à esquerda do "excluir". O
 * ícone (duas folhas sobrepostas) é desenhado em CSS (`::before`/`::after`),
 * não com um ícone SVG — mesmo motivo do "X" de `.flow-edge-delete` e da
 * lixeira: SVG dentro desses botões não centralizava de forma confiável
 * neste ambiente. */
export function DuplicateNodeButton({ onDuplicate }: DuplicateNodeButtonProps) {
  const { t } = useLanguage()
  const { triggerProps, tooltip } = useTooltip(t('flows.canvas.duplicateNodeAria'), { side: 'top' })

  return (
    <>
      <button
        type="button"
        className="flow-node-toolbar-button flow-node-toolbar-button--duplicate"
        aria-label={t('flows.canvas.duplicateNodeAria')}
        {...triggerProps}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onDuplicate()
        }}
      />
      {tooltip}
    </>
  )
}
