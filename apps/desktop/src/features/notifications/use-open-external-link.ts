import { useCallback, type MouseEvent } from 'react'
import { openExternalUrl } from '../../bindings/open-external-url'
import { useLanguage } from '../../shared/i18n/use-language'
import { useToast } from '../../shared/ui/use-toast'

/** Clique em link de notificação: nunca navega a própria janela, abre no navegador do sistema. */
export function useOpenExternalLink() {
  const { t } = useLanguage()
  const { showToast } = useToast()

  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>, url: string) => {
      event.preventDefault()
      event.stopPropagation()
      void openExternalUrl(url).then((result) => {
        if (!result.ok) showToast(t('notifications.linkError'), 'error')
      })
    },
    [showToast, t],
  )
}
