import { useEffect, useState } from 'react'
import { closeWindow } from '../../bindings/close-window'
import { isWindowMaximized } from '../../bindings/is-window-maximized'
import { minimizeWindow } from '../../bindings/minimize-window'
import { onWindowResized } from '../../bindings/on-window-resized'
import { toggleMaximizeWindow } from '../../bindings/toggle-maximize-window'
import { useLanguage } from '../i18n/use-language'
import { IconButton } from './IconButton'
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from './icons'

/** Botões de controle da janela (minimizar/maximizar/fechar), substituindo a
 * decoração nativa do SO (`decorations: false` em tauri.conf.json). */
export function WindowControls() {
  const { t } = useLanguage()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let cancelled = false

    void isWindowMaximized().then((value) => {
      if (!cancelled) setMaximized(value)
    })

    const unlistenPromise = onWindowResized(async () => {
      const value = await isWindowMaximized()
      if (!cancelled) setMaximized(value)
    })

    return () => {
      cancelled = true
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  return (
    <div className="app-titlebar-controls">
      <IconButton icon={<MinimizeIcon size={13} />} label={t('titleBar.minimizeAria')} onClick={() => void minimizeWindow()} />
      <IconButton
        icon={maximized ? <RestoreIcon size={13} /> : <MaximizeIcon size={13} />}
        label={maximized ? t('titleBar.restoreAria') : t('titleBar.maximizeAria')}
        onClick={() => void toggleMaximizeWindow()}
      />
      <IconButton
        icon={<CloseIcon size={13} />}
        label={t('titleBar.closeAria')}
        variant="danger"
        onClick={() => void closeWindow()}
      />
    </div>
  )
}
