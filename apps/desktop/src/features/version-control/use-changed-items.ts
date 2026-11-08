import { useEffect, useMemo, useState } from 'react'
import { cancelVersionControlOperation } from '../../bindings/cancel-version-control-operation'
import { getStructuredFileChanges } from '../../bindings/get-structured-file-changes'
import type { FileStatusDto, ItemChangeKind } from '../../bindings/version-control-types'

/**
 * Mapa id do item (sem o prefixo `kind:` de `ChangedItemDto.id`) → tipo de
 * alteração, para marcar coleções/pastas/requisições/flows/ambientes com
 * "M"/"A"/"D" nas árvores da sidebar sem repetir a consulta em cada árvore.
 * Só busca os arquivos rastreados que têm diferença — em workspace limpo
 * (o caso comum) não há nenhuma chamada.
 */
const EMPTY_MARKERS: Map<string, ItemChangeKind> = new Map()

export function useChangedItemMarkers(rootPath: string, files: FileStatusDto[]): Map<string, ItemChangeKind> {
  const [markers, setMarkers] = useState<Map<string, ItemChangeKind>>(EMPTY_MARKERS)
  const changedFiles = useMemo(() => files.filter((file) => file.state !== 'clean'), [files])
  // Dispara de novo só quando o conjunto de arquivos alterados muda de fato
  // (não a cada novo array de `files` com o mesmo conteúdo, recriado a cada
  // verificação de status).
  const key = changedFiles
    .map((file) => `${file.name}:${file.state}:${file.localRevision ?? ''}:${file.remoteRevision ?? ''}`)
    .join('|')

  useEffect(() => {
    // Sem `setState` aqui: workspace limpo é resolvido abaixo, sem passar
    // pelo estado (evita um segundo render só pra zerar o mapa).
    if (changedFiles.length === 0) return

    let cancelled = false
    const operationIds: string[] = []

    void Promise.all(
      changedFiles.map(async (file) => {
        const operationId = crypto.randomUUID()
        operationIds.push(operationId)
        const result = await getStructuredFileChanges(rootPath, operationId, file.name, file.remoteRevision, file.localRevision)
        return result.ok ? result.value.items : []
      }),
    ).then((lists) => {
      if (cancelled) return
      const next = new Map<string, ItemChangeKind>()
      for (const items of lists) {
        for (const item of items) {
          next.set(item.id.slice(item.id.indexOf(':') + 1), item.changeKind)
        }
      }
      setMarkers(next)
    })

    return () => {
      cancelled = true
      operationIds.forEach((id) => void cancelVersionControlOperation(id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changedFiles` é recriado a cada render; `key` já resume o que importa (nomes + estados).
  }, [rootPath, key])

  return changedFiles.length === 0 ? EMPTY_MARKERS : markers
}
