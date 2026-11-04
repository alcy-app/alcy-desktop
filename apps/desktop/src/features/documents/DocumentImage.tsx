import { useEffect, useState } from 'react'
import { documentImageUrl } from '../../bindings/documentation'
import { useLanguage } from '../../shared/i18n/use-language'
import { ImageIcon } from '../../shared/ui/icons'

/** Loads an attached image natively in chunks and shows it as an object URL. */
export function DocumentImage({ rootPath, documentId, assetId, caption, variant = 'figure' }: { rootPath: string; documentId: string; assetId: string; caption: string; variant?: 'figure' | 'thumbnail' }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const { t } = useLanguage()
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    void documentImageUrl(rootPath, documentId, assetId).then((result) => {
      objectUrl = result
      if (cancelled) URL.revokeObjectURL(result)
      else setUrl(result)
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [rootPath, documentId, assetId])
  const body = url
    ? <img src={url} alt={caption} />
    : <span className="document-image-placeholder" role={failed ? undefined : 'status'}><ImageIcon size={variant === 'thumbnail' ? 16 : 20} />{variant === 'figure' && t(failed ? 'documents.imageFailed' : 'documents.loading')}</span>
  if (variant === 'thumbnail') return <span className="document-thumbnail" title={failed ? t('documents.imageFailed') : undefined}>{body}</span>
  return <span className="document-image">{body}<span className="document-caption">{caption}</span></span>
}
