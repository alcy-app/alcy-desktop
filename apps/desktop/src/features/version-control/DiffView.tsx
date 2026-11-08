import { useEffect, useState } from 'react'
import type { DiffHunkDto, FileDiffDto, VersionControlCommandError } from '../../bindings/version-control-types'
import { getFileDiff } from '../../bindings/get-file-diff'
import { cancelVersionControlOperation } from '../../bindings/cancel-version-control-operation'
import { versionControlErrorMessage } from '../../shared/version-control-error-message'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { DiffHunks, type DiffHunkView } from '../../shared/ui/DiffHunks'
import { Spinner } from '../../shared/ui/icons'

interface DiffViewProps {
  rootPath: string
  fileName: string
  /** Muda quando o estado do workspace muda, para recarregar o diff aberto. */
  version: unknown
  remoteRevision?: string | null
  onClose?: () => void
  direction?: 'outgoing' | 'incoming'
}

type DiffState = { status: 'loading' } | { status: 'ready'; diff: FileDiffDto } | { status: 'error'; error: VersionControlCommandError }

/** Diferenças entre a versão remota (esquerda, vermelho) e a local (direita, verde) de um arquivo. */
export function DiffView({ rootPath, fileName, version, remoteRevision, onClose, direction = 'outgoing' }: DiffViewProps) {
  const { t } = useLanguage()
  const [state, setState] = useState<DiffState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const operationId = crypto.randomUUID()
    // O rascunho anterior fica visível até o novo chegar, sem piscar o carregamento.
    void getFileDiff(rootPath, operationId, fileName, remoteRevision).then((result) => {
      if (cancelled) return
      setState(result.ok ? { status: 'ready', diff: result.value } : { status: 'error', error: result.error })
    })
    return () => {
      cancelled = true
      void cancelVersionControlOperation(operationId)
    }
  }, [rootPath, fileName, version, remoteRevision])

  return (
    <section className="vc-diff" aria-label={t('vc.diff.title', { file: fileName })}>
      <header className="vc-diff-header">
        <h3 className="vc-diff-title">{t('vc.diff.title', { file: fileName })}</h3>
        {onClose && <Button variant="ghost" onClick={onClose} aria-label={t('vc.diff.close')}>{t('vc.diff.close')}</Button>}
      </header>
      {state.status === 'loading' && (
        <p className="vc-diff-message" role="status">
          <Spinner size={14} /> {t('vc.diff.loading')}
        </p>
      )}
      {state.status === 'error' && <InlineAlert>{versionControlErrorMessage(state.error, t)}</InlineAlert>}
      {state.status === 'ready' && <DiffBody diff={state.diff} direction={direction} />}
    </section>
  )
}

function DiffBody({ diff, direction }: { diff: FileDiffDto; direction: 'outgoing' | 'incoming' }) {
  const { t } = useLanguage()

  if (diff.tooLarge) return <p className="vc-diff-message">{t('vc.diff.tooLarge')}</p>
  if (diff.binary) return <p className="vc-diff-message">{t('vc.diff.binary')}</p>
  if (diff.hunks.length === 0) return <p className="vc-diff-message">{t('vc.diff.noDifference')}</p>

  return (
    <>
      {direction === 'outgoing' && !diff.remoteExists && <p className="vc-diff-message">{t('vc.diff.notOnRemote')}</p>}
      {direction === 'outgoing' && !diff.localExists && <p className="vc-diff-message">{t('vc.diff.notLocal')}</p>}
      <div className="vc-diff-body" tabIndex={0} role="region" aria-label={t('vc.diff.contentAria')}>
        <DiffHunks hunks={direction === 'incoming' ? diff.hunks.map(incomingHunk) : diff.hunks.map(outgoingHunk)} />
      </div>
      {diff.truncated && <p className="vc-diff-message">{t('vc.diff.truncated')}</p>}
    </>
  )
}

/** Envio: o remoto é o lado antigo e o local, o novo. */
function outgoingHunk(hunk: DiffHunkDto): DiffHunkView {
  return { oldStart: hunk.remoteStart, newStart: hunk.localStart, lines: hunk.lines }
}

/** Recebimento: o local é o lado antigo e o remoto, o novo — adições e remoções se invertem. */
function incomingHunk(hunk: DiffHunkDto): DiffHunkView {
  return {
    oldStart: hunk.localStart,
    newStart: hunk.remoteStart,
    lines: hunk.lines.map((line) => ({
      ...line,
      kind: line.kind === 'added' ? 'removed' : line.kind === 'removed' ? 'added' : 'context',
    })),
  }
}
