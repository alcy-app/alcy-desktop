import { useEffect, useRef, useState } from 'react'
import { onFileDrop } from '../../../bindings/on-file-drop'
import { useLanguage } from '../../../shared/i18n/use-language'
import { ImportIcon, Spinner } from '../../../shared/ui/icons'
import { hasOpenModal } from '../../../shared/ui/open-modals'
import { useToast } from '../../../shared/ui/use-toast'
import type { ImportOutcome } from '../use-collections-state'
import { isImportDropPath } from '../import-drop'
import './import-drop-overlay.css'

interface ImportDropOverlayProps {
  onImportFromPath: (path: string) => Promise<ImportOutcome>
}

/**
 * Importa sem abrir a modal: soltar arquivos de coleção, comandos curl em
 * arquivo de texto e pastas em qualquer ponto da janela. Imagens do
 * "Compartilhar como imagem" abrem a requisição como rascunho, pelo mesmo
 * caminho. Enquanto o arquivo está sobre a janela, um aviso cobre a tela; ao
 * soltar, cada caminho é importado em sequência. Com um modal aberto
 * (inclusive o de importar, que trata o próprio arraste) nada acontece.
 */
export function ImportDropOverlay({ onImportFromPath }: ImportDropOverlayProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [state, setState] = useState<'idle' | 'dragging' | 'importing'>('idle')
  const importRef = useRef(onImportFromPath)
  const busyRef = useRef(false)
  useEffect(() => {
    importRef.current = onImportFromPath
  })

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const stopDragging = () => setState((current) => (current === 'dragging' ? 'idle' : current))

    void onFileDrop((event) => {
      if (event.type === 'enter') {
        if (!hasOpenModal() && event.paths.some(isImportDropPath)) {
          setState((current) => (current === 'idle' ? 'dragging' : current))
        }
        return
      }
      if (event.type === 'leave') {
        stopDragging()
        return
      }
      if (event.type !== 'drop') return

      const paths = event.paths.filter(isImportDropPath)
      if (busyRef.current) return
      if (hasOpenModal() || paths.length === 0) {
        stopDragging()
        return
      }
      busyRef.current = true
      setState('importing')
      void (async () => {
        for (const path of paths) {
          const result = await importRef.current(path)
          if (!result.ok) showToast(t('importDrop.error', { message: result.message }), 'error')
        }
        busyRef.current = false
        setState('idle')
      })()
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [t, showToast])

  if (state === 'idle') return null

  return (
    <div className="import-drop-overlay" role="status" aria-live="polite">
      <div className="import-drop-overlay-card">
        <span className="import-drop-overlay-icon">{state === 'importing' ? <Spinner size={24} /> : <ImportIcon size={24} />}</span>
        <p className="import-drop-overlay-title">
          {state === 'importing' ? t('importDrop.importing') : t('importDrop.title')}
        </p>
        {state === 'dragging' && <p className="import-drop-overlay-hint">{t('importDrop.hint')}</p>}
      </div>
    </div>
  )
}
