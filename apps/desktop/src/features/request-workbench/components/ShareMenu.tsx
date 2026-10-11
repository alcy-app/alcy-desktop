import { useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { MenuItem } from '../../../shared/ui/Menu'
import { ShareIcon } from '../../../shared/ui/icons'
import './share-menu.css'

interface ShareMenuProps {
  onShareAsCode: () => void
  onShareAsImage: () => void
}

interface MenuPosition {
  top: number
  right: number
}

const MENU_GAP_PX = 4

/** "Compartilhar" com as formas de compartilhar a requisição: código ou imagem.
 * O menu vai em portal, com posição fixa sob o botão: a linha do breadcrumb
 * corta o que transborda (`overflow: hidden`). */
export function ShareMenu({ onShareAsCode, onShareAsImage }: ShareMenuProps) {
  const { t } = useLanguage()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const open = position !== null

  useEffect(() => {
    if (!open) return
    // Foco inicial aqui, e não com `autoFocus`: o React focaria o item antes de
    // ligar `menuRef`, e o blur do botão fecharia o menu na hora.
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    // A posição é fixa na tela; redimensionar a janela deixaria o menu solto.
    const close = () => setPosition(null)
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [open])

  const toggle = () => {
    if (open) {
      setPosition(null)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({ top: rect.bottom + MENU_GAP_PX, right: window.innerWidth - rect.right })
  }

  const select = (action: () => void) => {
    setPosition(null)
    action()
  }

  // Eventos do portal sobem pela árvore do React, mas no DOM o menu fica fora do host.
  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (!event.currentTarget.contains(next) && !menuRef.current?.contains(next)) setPosition(null)
  }

  return (
    <div className="ui-menu-host" onBlur={closeOnBlur}>
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        className="rw-share-button"
        aria-label={t('share.buttonAria')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
      >
        <ShareIcon size={12} />
        {t('share.button')}
      </Button>
      {position &&
        createPortal(
          <div
            ref={menuRef}
            className="ui-menu rw-share-menu"
            role="menu"
            aria-label={t('share.buttonAria')}
            style={{ top: position.top, right: position.right }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setPosition(null)
                buttonRef.current?.focus()
              }
            }}
          >
            <MenuItem label={t('share.menu.code')} onSelect={() => select(onShareAsCode)} />
            <MenuItem label={t('share.menu.image')} onSelect={() => select(onShareAsImage)} />
          </div>,
          document.body,
        )}
    </div>
  )
}
