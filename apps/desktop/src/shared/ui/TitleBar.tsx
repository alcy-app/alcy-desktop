import type { ReactNode } from 'react'
import { WindowControls } from './WindowControls'
import './title-bar.css'

interface TitleBarProps {
  children?: ReactNode
  className?: string
}

/** Barra única, arrastável, que funde a titlebar da janela (sem decoração nativa,
 * `decorations: false`) com o cabeçalho do app. `children` é o conteúdo específico da
 * tela (marca, menus, ações); os controles de janela ficam fixos à direita. */
export function TitleBar({ children, className }: TitleBarProps) {
  const classes = ['app-titlebar', className].filter(Boolean).join(' ')
  return (
    <div className={classes} data-tauri-drag-region>
      <div className="app-titlebar-content" data-tauri-drag-region>
        {children}
      </div>
      <WindowControls />
    </div>
  )
}
