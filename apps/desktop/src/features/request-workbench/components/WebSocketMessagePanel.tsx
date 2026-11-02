import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { WebSocketMessageFormat } from '../../../bindings/websocket-call'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { SegmentedControl } from '../../../shared/ui/SegmentedControl'
import { describeError } from '../response-summary'
import type { WebSocketStreamState } from '../websocket-stream'
import { RequestBodyPanel } from './RequestBodyPanel'
import './grpc.css'
import './websocket.css'

interface WebSocketMessagePanelProps {
  message: string
  format: WebSocketMessageFormat
  onMessageChange: (message: string) => void
  onFormatChange: (format: WebSocketMessageFormat) => void
  stream?: WebSocketStreamState
  /** Whether a connection of this tab is in progress (connecting or open). */
  isConnected: boolean
  onSend: () => void
  environmentVariables: EnvironmentVariableDto[]
}

/** The composer of a WebSocket request (spec 0140): one message, saved with
 * the request and sent on the open connection as many times as needed. */
export function WebSocketMessagePanel({
  message,
  format,
  onMessageChange,
  onFormatChange,
  stream,
  isConnected,
  onSend,
  environmentVariables,
}: WebSocketMessagePanelProps) {
  const { t } = useLanguage()
  const open = isConnected && stream?.status === 'open'
  const status = !isConnected
    ? t('websocket.status.disconnected')
    : t(`websocket.status.${stream?.status ?? 'connecting'}`)

  return (
    <div className="rw-grpc-message rw-websocket-message">
      <div className="rw-grpc-message-toolbar">
        <SegmentedControl<WebSocketMessageFormat>
          layout="inline"
          size="sm"
          ariaLabel={t('websocket.formatLabel')}
          value={format}
          onChange={onFormatChange}
          options={[
            { value: 'text', label: t('websocket.format.text') },
            { value: 'json', label: 'JSON' },
            { value: 'binary', label: t('websocket.format.binary') },
          ]}
        />
      </div>
      {format === 'binary' && (
        <p className="rw-grpc-message-note" role="note">
          {t('websocket.binaryNote')}
        </p>
      )}
      {stream?.error && (
        <p role="alert" className="rw-grpc-stream-error">
          {describeError(t, stream.error)}
        </p>
      )}
      <RequestBodyPanel
        key={format}
        value={message}
        onChange={onMessageChange}
        language={format === 'json' ? 'json' : 'none'}
        label={t('websocket.messageLabel')}
        environmentVariables={environmentVariables}
      />
      <div className="rw-grpc-message-footer" role="group" aria-label={t('websocket.controls')}>
        <span className="rw-grpc-message-state" role="status">
          {status}
        </span>
        <Button size="sm" disabled={!open || stream.busy} onClick={onSend} title={open ? undefined : t('websocket.sendNeedsConnection')}>
          {t('websocket.sendMessage')}
        </Button>
      </div>
    </div>
  )
}
