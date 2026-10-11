import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { InlineAlert } from '../../../shared/ui/InlineAlert'

export type WorkspaceArea = 'collections' | 'environments' | 'flows' | 'valueMonitors'

export interface WorkspaceAreaLoad {
  area: WorkspaceArea
  /** Erro da última leitura; `null` quando a área foi lida. */
  message: string | null
  retry: () => void
}

interface WorkspaceLoadErrorsProps {
  areas: WorkspaceAreaLoad[]
}

/**
 * Avisa quais áreas do workspace não foram lidas (spec 0120). Enquanto o
 * aviso aparece, essas áreas não são salvas: a tela mostra uma lista vazia, e
 * gravá-la apagaria o que está no disco.
 */
export function WorkspaceLoadErrors({ areas }: WorkspaceLoadErrorsProps) {
  const { t } = useLanguage()
  const failed = areas.filter((area) => area.message !== null)
  if (failed.length === 0) return null

  return (
    <InlineAlert className="rw-load-errors">
      <p>
        <strong>{t('workbench.loadErrors.title')}</strong> {t('workbench.loadErrors.body')}
      </p>
      <ul>
        {failed.map((area) => (
          <li key={area.area}>
            {t(`workbench.loadErrors.area.${area.area}`)}: {area.message}
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={() => failed.forEach((area) => area.retry())}>
        {t('workbench.loadErrors.retry')}
      </Button>
    </InlineAlert>
  )
}
