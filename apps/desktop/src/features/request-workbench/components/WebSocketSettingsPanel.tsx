import type { ChangeEvent } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Field } from '../../../shared/ui/Field'
import { Input } from '../../../shared/ui/Input'
import type { WebSocketCallState } from '../collection-tree'
import './websocket.css'

interface WebSocketSettingsPanelProps {
  websocket: WebSocketCallState
  onChange: (patch: Partial<WebSocketCallState>) => void
}

function positiveOrNull(event: ChangeEvent<HTMLInputElement>, allowZero = false): number | null {
  if (event.target.value.trim() === '') return null
  const value = Number(event.target.value)
  if (!Number.isFinite(value)) return null
  return value > 0 || (allowZero && value === 0) ? Math.floor(value) : null
}

/** Subprotocols offered on connect and how runs and flows collect replies
 * (spec 0140). */
export function WebSocketSettingsPanel({ websocket, onChange }: WebSocketSettingsPanelProps) {
  const { t } = useLanguage()
  return (
    <div className="rw-websocket-settings">
      <Field label={t('websocket.subprotocolsLabel')} hint={t('websocket.subprotocolsHint')}>
        {(id) => (
          <Input
            id={id}
            value={websocket.subprotocols.join(', ')}
            placeholder="graphql-transport-ws"
            onChange={(event) =>
              onChange({
                subprotocols: event.target.value
                  .split(',')
                  .map((subprotocol) => subprotocol.trim())
                  .filter((subprotocol, index, all) => subprotocol !== '' || index === all.length - 1),
              })
            }
            onBlur={() => onChange({ subprotocols: websocket.subprotocols.filter((subprotocol) => subprotocol !== '') })}
          />
        )}
      </Field>
      <p className="rw-websocket-settings-section">{t('websocket.runSettingsTitle')}</p>
      <Field label={t('websocket.waitLabel')} hint={t('websocket.waitHint')}>
        {(id) => (
          <Input
            id={id}
            type="number"
            min={1}
            inputMode="numeric"
            placeholder={t('websocket.waitPlaceholder')}
            value={websocket.waitMs ?? ''}
            onChange={(event) => onChange({ waitMs: positiveOrNull(event) })}
          />
        )}
      </Field>
      <Field label={t('websocket.expectedLabel')} hint={t('websocket.expectedHint')}>
        {(id) => (
          <Input
            id={id}
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="1"
            value={websocket.expectedMessages ?? ''}
            onChange={(event) => onChange({ expectedMessages: positiveOrNull(event, true) })}
          />
        )}
      </Field>
    </div>
  )
}
