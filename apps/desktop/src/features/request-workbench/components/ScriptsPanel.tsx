import { useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Tabs } from '../../../shared/ui/Tabs'
import type { ExecutionState } from '../request-workbench.types'
import { scriptCompletionExtension } from '../script-completions'
import { scriptReservedHighlight } from '../script-highlight'
import { RequestBodyPanel } from './RequestBodyPanel'

type ScriptKind = 'pre' | 'post'

interface ScriptsPanelProps {
  preRequestScript: string
  postResponseScript: string
  onPreRequestScriptChange: (value: string) => void
  onPostResponseScriptChange: (value: string) => void
  execution: ExecutionState
  /** Identifica o documento (a aba): outro valor recria os editores, cada um com seu próprio
   * histórico de desfazer, mas mantém a escolha entre pré-requisição e pós-resposta. */
  editorKey?: string
}

/** Falha de script da última execução; os logs (`al.console.log`) vão para o console do app. */
function lastRunError(execution: ExecutionState): string | null {
  if (execution.status === 'success') return 'scriptError' in execution.result ? (execution.result.scriptError?.message ?? null) : null
  if (execution.status === 'error' && execution.error.kind === 'script') return execution.error.message
  return null
}

/**
 * Aba Scripts: um editor JavaScript para o script de pré-requisição e outro
 * para o de pós-resposta (spec 0054). O editor é remontado ao alternar
 * (`key`), já que cada um tem seu próprio histórico de desfazer.
 */
export function ScriptsPanel({
  preRequestScript,
  postResponseScript,
  onPreRequestScriptChange,
  onPostResponseScriptChange,
  execution,
  editorKey = '',
}: ScriptsPanelProps) {
  const { t } = useLanguage()
  const [active, setActive] = useState<ScriptKind>('pre')
  const error = lastRunError(execution)

  const tabs: { id: ScriptKind; label: string; badge?: number }[] = [
    { id: 'pre', label: t('scripts.preRequest') },
    { id: 'post', label: t('scripts.postResponse') },
  ]

  return (
    <div className="rw-panel rw-scripts-panel">
      <Tabs tabs={tabs} activeTab={active} onChange={setActive} ariaLabel={t('scripts.kindsLabel')} idPrefix="script-" variant="compact" />
      <div key={active} id={`tabpanel-script-${active}`} role="tabpanel" aria-labelledby={`tab-script-${active}`} className="rw-scripts-editor ui-tabpanel-motion">
        {active === 'pre' ? (
          <RequestBodyPanel
            key={`${editorKey}\npre`}
            extraExtensions={[scriptCompletionExtension('pre'), scriptReservedHighlight()]}
            language="javascript"
            label={t('scripts.preRequestEditorLabel')}
            value={preRequestScript}
            onChange={onPreRequestScriptChange}
          />
        ) : (
          <RequestBodyPanel
            key={`${editorKey}\npost`}
            extraExtensions={[scriptCompletionExtension('post'), scriptReservedHighlight()]}
            language="javascript"
            label={t('scripts.postResponseEditorLabel')}
            value={postResponseScript}
            onChange={onPostResponseScriptChange}
          />
        )}
      </div>
      {error && (
        <div className="rw-script-output" role="alert">
          <p className="rw-script-output-error">{t('scripts.error', { message: error })}</p>
        </div>
      )}
    </div>
  )
}
