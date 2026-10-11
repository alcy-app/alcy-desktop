import './diff-hunks.css'

export type DiffHunkLineKind = 'context' | 'added' | 'removed'

export interface DiffHunkView {
  /** Primeira linha do trecho no lado antigo ("−"). */
  oldStart: number
  /** Primeira linha do trecho no lado novo ("+"). */
  newStart: number
  lines: { kind: DiffHunkLineKind; text: string }[]
}

const LINE_MARKERS = { context: ' ', added: '+', removed: '-' } as const

/** Trechos de um diff no estilo git: numeração dos dois lados, `+` em verde e `-` em vermelho. */
export function DiffHunks({ hunks }: { hunks: DiffHunkView[] }) {
  return (
    <>
      {hunks.map((hunk) => {
        let oldLine = hunk.oldStart
        let newLine = hunk.newStart
        return (
          <div key={`${hunk.oldStart}-${hunk.newStart}`} className="ui-diff-hunk">
            <div className="ui-diff-hunk-header">
              @@ -{hunk.oldStart} +{hunk.newStart} @@
            </div>
            {hunk.lines.map((line, index) => {
              const oldNumber = line.kind === 'added' ? '' : oldLine++
              const newNumber = line.kind === 'removed' ? '' : newLine++
              return (
                <div key={index} className={`ui-diff-line ui-diff-line--${line.kind}`}>
                  <span className="ui-diff-number" aria-hidden="true">{oldNumber}</span>
                  <span className="ui-diff-number" aria-hidden="true">{newNumber}</span>
                  <span className="ui-diff-marker" aria-hidden="true">
                    {LINE_MARKERS[line.kind]}
                  </span>
                  <span className="ui-diff-text">{line.text}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </>
  )
}
