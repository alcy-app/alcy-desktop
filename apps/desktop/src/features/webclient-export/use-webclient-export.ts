import { useEffect, useMemo, useState } from 'react'
import {
  exportWebclient,
  previewWebclientExport,
  type ExportWebclientError,
  type WebclientSelectionInput,
  type WebclientSummary,
  type WebclientTransportMode,
} from '../../bindings/export-webclient'
import type { CollectionDto } from '../../bindings/list-collections'
import { pickExportFile } from '../../bindings/pick-export-file'
import { definedVariables } from '../environments/defined-variables'
import type { EnvironmentState } from '../environments/environments.types'

/** Mesmo mínimo de `alcy_webclient::MIN_PASSWORD_CHARS`. */
export const MIN_PASSWORD_CHARS = 8

export interface WebclientExportSource {
  collection: CollectionDto
  folderId: string | null
  name: string
}

export type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; summary: WebclientSummary }
  | { status: 'error'; error: ExportWebclientError }

export type ExportOutcome = { status: 'exported' } | { status: 'cancelled' } | { status: 'failed'; error: ExportWebclientError }

/**
 * Estado local do diálogo de export como webclient (spec 0113). Dados
 * sensíveis começam fora; incluí-los exige marcar a inclusão e confirmar.
 */
export function useWebclientExport(source: WebclientExportSource, environments: EnvironmentState[], activeEnvironmentId: string | null) {
  const [title, setTitle] = useState(source.name)
  const [environmentId, setEnvironmentId] = useState<string | null>(activeEnvironmentId)
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [transport, setTransport] = useState<WebclientTransportMode>('auto')
  const [includeSensitive, setIncludeSensitiveState] = useState(false)
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false)
  /** Resultado da última prévia, com a entrada a que ele corresponde. */
  const [previewResult, setPreviewResult] = useState<{
    selection: WebclientSelectionInput
    includeSensitive: boolean
    state: PreviewState
  } | null>(null)
  const [exporting, setExporting] = useState(false)

  const environment = environments.find((candidate) => candidate.id === environmentId) ?? null
  const selection = useMemo<WebclientSelectionInput>(
    () => ({
      collection: source.collection,
      folderId: source.folderId,
      environment: environment
        ? {
            name: environment.name,
            variables: definedVariables(environment.variables).map(({ name, value, sensitive }) => ({ name, value, sensitive })),
          }
        : null,
    }),
    [source.collection, source.folderId, environment],
  )

  useEffect(() => {
    let active = true
    void previewWebclientExport(selection, includeSensitive).then((result) => {
      if (!active) return
      setPreviewResult({
        selection,
        includeSensitive,
        state: result.ok ? { status: 'ready', summary: result.value } : { status: 'error', error: result.error },
      })
    })
    return () => {
      active = false
    }
  }, [selection, includeSensitive])

  // Uma prévia de outra entrada (ambiente ou inclusão de sensíveis trocados) ainda está chegando.
  const preview: PreviewState =
    previewResult && previewResult.selection === selection && previewResult.includeSensitive === includeSensitive
      ? previewResult.state
      : { status: 'loading' }

  const setIncludeSensitive = (include: boolean) => {
    setIncludeSensitiveState(include)
    if (!include) setSensitiveConfirmed(false)
  }

  const passwordError: 'tooShort' | 'mismatch' | null =
    password === ''
      ? null
      : password.length < MIN_PASSWORD_CHARS
        ? 'tooShort'
        : password !== passwordConfirmation
          ? 'mismatch'
          : null

  const canExport =
    preview.status === 'ready' && !exporting && passwordError === null && (!includeSensitive || sensitiveConfirmed)

  const runExport = async (): Promise<ExportOutcome> => {
    if (!canExport) return { status: 'cancelled' }
    const path = await pickExportFile(title.trim() || source.name, 'html')
    if (path === null) return { status: 'cancelled' }
    setExporting(true)
    const result = await exportWebclient({
      ...selection,
      path,
      title,
      transport,
      includeSensitive,
      sensitiveConfirmed,
      password: password === '' ? null : password,
    })
    setExporting(false)
    return result.ok ? { status: 'exported' } : { status: 'failed', error: result.error }
  }

  return {
    title,
    setTitle,
    environmentId,
    setEnvironmentId,
    password,
    setPassword,
    passwordConfirmation,
    setPasswordConfirmation,
    passwordError,
    transport,
    setTransport,
    includeSensitive,
    setIncludeSensitive,
    sensitiveConfirmed,
    setSensitiveConfirmed,
    preview,
    exporting,
    canExport,
    runExport,
  }
}
