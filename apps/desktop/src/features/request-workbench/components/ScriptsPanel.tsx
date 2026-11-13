import { useEffect, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ScriptsSkipReason } from '../../../bindings/script-trust'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { LockIcon } from '../../../shared/ui/icons'
import { Tabs } from '../../../shared/ui/Tabs'
import type { ExecutionState } from '../request-workbench.types'
import { scriptCompletionExtension } from '../script-completions'
import { scriptReservedHighlight } from '../script-highlight'
import { RequestBodyPanel } from './RequestBodyPanel'
import { registerEditorRevealer } from '../editor-bridge'
import './script-trust.css'

/** The scripts of this request do not run until someone trusts them (spec 0162). */
export interface ScriptsLock {
  reason: ScriptsSkipReason
  onTrust: () => void
}

const READ_ONLY = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

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
  /** Exposes both editors to the agent (ADR 0064); only the workbench sets it. */
  agentEditors?: boolean
  /** Scripts that do not run: the editors become read-only and say why. */
  lock?: ScriptsLock | null
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
  agentEditors = false,
  lock = null,
}: ScriptsPanelProps) {
  const { t } = useLanguage()
  const [active, setActive] = useState<ScriptKind>('pre')
  useEffect(() => {
    if (!agentEditors) return
    const unregisterPre = registerEditorRevealer('preRequestScript', () => setActive('pre'))
    const unregisterPost = registerEditorRevealer('postResponseScript', () => setActive('post'))
    return () => {
      unregisterPre()
      unregisterPost()
    }
  }, [agentEditors])
  const error = lastRunError(execution)

  const tabs: { id: ScriptKind; label: string; badge?: number }[] = [
    { id: 'pre', label: t('scripts.preRequest') },
    { id: 'post', label: t('scripts.postResponse') },
  ]

  // Editors read their extensions at mount: the lock is part of their key.
  const lockKey = lock ? '\nlocked' : ''
  const lockExtensions = lock ? READ_ONLY : []
  const agentSlots = agentEditors && !lock

  return (
    <div className="rw-panel rw-scripts-panel">
      {lock && (
        <div className="rw-scripts-lock" role="status">
          <LockIcon size={14} />
          <span className="rw-scripts-lock-text">
            {t(lock.reason === 'workspace' ? 'scriptTrust.lockedByWorkspace' : 'scriptTrust.lockedByCollection')}
          </span>
          <Button size="sm" variant="ghost" onClick={lock.onTrust}>
            {t(lock.reason === 'workspace' ? 'scriptTrust.trustWorkspace' : 'scriptTrust.trustCollection')}
          </Button>
        </div>
      )}
      <Tabs tabs={tabs} activeTab={active} onChange={setActive} ariaLabel={t('scripts.kindsLabel')} idPrefix="script-" variant="compact" />
      <div key={active} id={`tabpanel-script-${active}`} role="tabpanel" aria-labelledby={`tab-script-${active}`} className="rw-scripts-editor ui-tabpanel-motion">
        {active === 'pre' ? (
          <RequestBodyPanel
            key={`${editorKey}\npre${lockKey}`}
            historyKey={editorKey ? `${editorKey}\npre` : undefined}
            extraExtensions={[scriptCompletionExtension('pre'), scriptReservedHighlight(), ...lockExtensions]}
            language="javascript"
            label={t('scripts.preRequestEditorLabel')}
            value={preRequestScript}
            onChange={onPreRequestScriptChange}
            agentSlot={agentSlots ? 'preRequestScript' : undefined}
          />
        ) : (
          <RequestBodyPanel
            key={`${editorKey}\npost${lockKey}`}
            historyKey={editorKey ? `${editorKey}\npost` : undefined}
            extraExtensions={[scriptCompletionExtension('post'), scriptReservedHighlight(), ...lockExtensions]}
            language="javascript"
            label={t('scripts.postResponseEditorLabel')}
            value={postResponseScript}
            onChange={onPostResponseScriptChange}
            agentSlot={agentSlots ? 'postResponseScript' : undefined}
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
