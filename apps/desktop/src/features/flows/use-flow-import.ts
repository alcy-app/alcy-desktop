import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { FlowDto } from '../../bindings/list-flows'
import { pickFlowImportFile, readFlowImport } from '../../bindings/import-flow'
import type { LoadTestImportAnalysisDto, LoadTestImportError } from '../../bindings/load-test-import'
import { useLanguage } from '../../shared/i18n/use-language'

interface FlowImportOptions {
  rootPath: string
  loadTestingEnabled: boolean
  onImport(flow: FlowDto): Promise<string>
  onImported(id: string): void
  onError(message: string): void
  onLoadTest?(sourcePath: string, analysis: LoadTestImportAnalysisDto): void
}

export function useFlowImport({ rootPath, loadTestingEnabled, onImport, onImported, onError, onLoadTest }: FlowImportOptions) {
  const { t } = useLanguage()
  const [importingFlow, setImportingFlow] = useState(false)
  const busy = useRef(false)
  const scope = useRef<{ root: string } | null>({ root: rootPath })
  useLayoutEffect(() => {
    scope.current = { root: rootPath }
    return () => { scope.current = null }
  }, [rootPath])

  const importFlowFile = useCallback(() => {
    if (busy.current) return
    busy.current = true
    const initialScope = scope.current
    const isCurrent = () => scope.current === initialScope && scope.current?.root === rootPath
    void (async () => {
      try {
        const path = await pickFlowImportFile(loadTestingEnabled)
        if (!path || !isCurrent()) return
        setImportingFlow(true)
        const result = await readFlowImport(path)
        if (!isCurrent()) return
        if (result.type === 'loadTest') {
          if (!loadTestingEnabled || !onLoadTest) throw new Error(t('flows.import.loadDisabled'))
          onLoadTest(path, result.analysis)
          return
        }
        const flow = result.flow
        if (flow.executionKind === 'load' && !loadTestingEnabled) throw new Error(t('flows.import.loadDisabled'))
        const id = await onImport(flow)
        if (isCurrent()) onImported(id)
      } catch (error) {
        if (isCurrent()) {
          const loadError = error as LoadTestImportError | null
          const message = loadError?.kind === 'incompatible'
            ? loadError.diagnostics.map((diagnostic) => `L${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`).join('\n')
            : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
              ? error.message : t('flows.import.error')
          onError(message)
        }
      } finally {
        busy.current = false
        if (scope.current !== null) setImportingFlow(false)
      }
    })()
  }, [rootPath, loadTestingEnabled, onImport, onImported, onError, onLoadTest, t])

  return { importFlowFile, importingFlow }
}
