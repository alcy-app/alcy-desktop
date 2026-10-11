import { useEffect, useRef, useState } from 'react'
import { onFileDrop } from '../../../bindings/on-file-drop'
import { useLanguage } from '../../../shared/i18n/use-language'
import { ImportIcon, Spinner } from '../../../shared/ui/icons'
import { hasOpenModal } from '../../../shared/ui/open-modals'
import { useToast } from '../../../shared/ui/use-toast'
import type { ImportOutcome } from '../use-collections-state'
import './image-import-drop-overlay.css'

const isPng = (path: string) => /\.png$/i.test(path)

interface ImageImportDropOverlayProps {
  onImportFromPath: (path: string) => Promise<ImportOutcome>
}

/**
 * Importar a requisição de uma imagem do "Compartilhar como imagem"
 * arrastando o PNG para qualquer ponto da janela. Enquanto o arquivo está
 * sobre a janela, um aviso cobre a tela; ao soltar, a requisição abre como
 * rascunho não salvo, o mesmo caminho da modal de importar. Com um modal aberto (inclusive o de
 * importar, que trata o próprio arraste) nada acontece.
 */
export function ImageImportDropOverlay({ onImportFromPath }: ImageImportDropOverlayProps) {
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
        if (!hasOpenModal() && event.paths.some(isPng)) setState((current) => (current === 'idle' ? 'dragging' : current))
        return
      }
      if (event.type === 'leave') {
        stopDragging()
        return
      }
      if (event.type !== 'drop') return

      const images = event.paths.filter(isPng)
      if (busyRef.current) return
      if (hasOpenModal() || images.length === 0) {
        stopDragging()
        return
      }
      busyRef.current = true
      setState('importing')
      void (async () => {
        for (const path of images) {
          const result = await importRef.current(path)
          if (!result.ok) showToast(t('imageImport.error', { message: result.message }), 'error')
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
    <div className="image-drop-overlay" role="status" aria-live="polite">
      <div className="image-drop-overlay-card">
        <span className="image-drop-overlay-icon">{state === 'importing' ? <Spinner size={24} /> : <ImportIcon size={24} />}</span>
        <p className="image-drop-overlay-title">
          {state === 'importing' ? t('imageImport.importing') : t('imageImport.dropTitle')}
        </p>
        {state === 'dragging' && <p className="image-drop-overlay-hint">{t('imageImport.dropHint')}</p>}
      </div>
    </div>
  )
}
