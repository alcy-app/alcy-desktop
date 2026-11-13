import { useRef, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { ChevronDownIcon, ChevronRightIcon, LockIcon } from '../../../shared/ui/icons'
import { Modal } from '../../../shared/ui/Modal'
import type { RequestSummary } from '../collection-tree'
import './script-trust.css'

/** Requests listed in the review; a workspace or collection with more shows how many were left out. */
const MAX_LISTED = 200

export interface ScriptTrustEntry {
  /** Collection and folder names leading to the request. */
  path: string[]
  request: RequestSummary
}

interface ScriptTrustDialogProps {
  title: string
  description: string
  /** Where the scripts come from (git remote or folder), when known. */
  origin?: string
  entries: ScriptTrustEntry[]
  confirmLabel: string
  declineLabel: string
  onConfirm: () => void
  /** Also called when the dialog is closed without choosing. */
  onDecline: () => void
}

/**
 * Asks whether to trust scripts the person did not write (spec 0162). "Do not trust" is the
 * default: it has the focus, Enter does not confirm, and closing the dialog declines. The scripts
 * can be read before deciding.
 */
export function ScriptTrustDialog({ title, description, origin, entries, confirmLabel, declineLabel, onConfirm, onDecline }: ScriptTrustDialogProps) {
  const { t } = useLanguage()
  const [showScripts, setShowScripts] = useState(false)
  const confirmed = useRef(false)
  const listed = entries.slice(0, MAX_LISTED)

  return (
    <Modal
      title={title}
      closeAriaLabel={t('common.close')}
      onClose={() => {
        if (!confirmed.current) onDecline()
      }}
      className="ui-modal--form script-trust-dialog"
    >
      {(requestClose) => (
        <>
          <p className="ui-modal-description script-trust-description">
            <LockIcon size={14} />
            <span>{description}</span>
          </p>
          {origin && <p className="script-trust-origin">{t('scriptTrust.origin', { origin })}</p>}
          <button type="button" className="script-trust-toggle" aria-expanded={showScripts} onClick={() => setShowScripts((current) => !current)}>
            {showScripts ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            <span>{t('scriptTrust.viewScripts', { count: entries.length })}</span>
          </button>
          {showScripts && (
            <ul className="script-trust-list">
              {listed.map(({ path, request }) => (
                <li key={request.id} className="script-trust-item">
                  <strong className="script-trust-item-name">{[...path, request.name].join(' / ')}</strong>
                  {request.content.preRequestScript.trim() !== '' && (
                    <ScriptCode label={t('scripts.preRequest')} code={request.content.preRequestScript} />
                  )}
                  {request.content.postResponseScript.trim() !== '' && (
                    <ScriptCode label={t('scripts.postResponse')} code={request.content.postResponseScript} />
                  )}
                </li>
              ))}
              {entries.length > listed.length && (
                <li className="script-trust-more">{t('scriptTrust.moreScripts', { count: entries.length - listed.length })}</li>
              )}
            </ul>
          )}
          <div className="ui-modal-actions">
            <Button
              variant="ghost"
              onClick={() => {
                confirmed.current = true
                onConfirm()
                requestClose()
              }}
            >
              {confirmLabel}
            </Button>
            <Button autoFocus onClick={requestClose}>
              {declineLabel}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}

function ScriptCode({ label, code }: { label: string; code: string }) {
  return (
    <div className="script-trust-code">
      <span className="script-trust-code-label">{label}</span>
      <pre>{code}</pre>
    </div>
  )
}
