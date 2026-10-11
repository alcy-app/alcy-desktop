import type { ItemChangeKind } from '../../bindings/gitlab-types'
import { useLanguage } from '../i18n/use-language'
import './change-marker.css'

const MARKER_LETTER: Record<ItemChangeKind, string> = { added: 'A', modified: 'M', deleted: 'D' }

/** Letra de status de alteração local (convenção "M"/"A"/"D" de clientes Git),
 * usada para marcar coleções/pastas/requisições/flows que diferem do remoto. */
export function ChangeMarker({ kind }: { kind: ItemChangeKind }) {
  const { t } = useLanguage()
  const label = t(`vc.change.${kind}`)

  return (
    <span className="ui-change-marker" data-kind={kind} title={label} aria-label={label}>
      {MARKER_LETTER[kind]}
    </span>
  )
}

/** Bolinha colorida (sem letra) para uma pasta/coleção que não mudou ela
 * mesma, mas contém algo que mudou: herda a cor do descendente mais "forte"
 * sem repetir a letra na pasta. */
export function ChangeDot({ kind }: { kind: ItemChangeKind }) {
  const { t } = useLanguage()
  const label = t('vc.change.nested')

  return <span className="ui-change-dot" data-kind={kind} title={label} aria-label={label} />
}
