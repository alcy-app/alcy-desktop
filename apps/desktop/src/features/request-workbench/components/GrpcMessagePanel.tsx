import { useMemo } from 'react'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { findGrpcMethod, grpcMessageSchema } from '../grpc-schema'
import type { GrpcStreamState } from '../grpc-stream'
import { describeError } from '../response-summary'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
import { RequestBodyPanel } from './RequestBodyPanel'
import './grpc.css'

interface GrpcMessagePanelProps {
  stream?: GrpcStreamState
  onSendMessage: () => void
  onCloseSend: () => void
  service: string
  method: string
  message: string
  isSending?: boolean
  onMessageChange: (message: string) => void
  schema: GrpcSchemaLoadState
  environmentVariables: EnvironmentVariableDto[]
}

/** The request message of a gRPC call, as JSON (spec 0129): completion from
 * the method's input type once the services are loaded, and a template with
 * every field to start from. */
export function GrpcMessagePanel({ stream, isSending = false, onSendMessage, onCloseSend, service, method, message, onMessageChange, schema, environmentVariables }: GrpcMessagePanelProps) {
  const { t } = useLanguage()
  const summary = schema.status === 'success' ? findGrpcMethod(schema.schema, service, method) : null
  const bodySchema = useMemo(() => (summary ? grpcMessageSchema(summary) : null), [summary])
  const streamsFromClient = summary?.kind === 'clientStreaming' || summary?.kind === 'bidiStreaming'

  return (
    <div className="rw-grpc-message">
      <div className="rw-grpc-message-toolbar">
        <span className="rw-grpc-message-type">
          {summary ? summary.inputType : method ? t('grpc.loadForFields') : t('grpc.messageNeedsMethod')}
        </span>
      </div>
      {streamsFromClient && (
        <p className="rw-grpc-message-note" role="note">
          {t('grpc.streamMessageNote')}
        </p>
      )}
      {stream?.error && <p role="alert" className="rw-grpc-stream-error">{describeError(t, stream.error)}</p>}
      <RequestBodyPanel
        value={message}
        onChange={onMessageChange}
        label={t('grpc.messageLabel')}
        environmentVariables={environmentVariables}
        bodySchema={bodySchema}
      />
      <div className="rw-grpc-message-footer" role="group" aria-label={t('grpc.streamControls')}>
        <Button className="rw-grpc-generate-example" variant="ghost" size="sm" disabled={!summary}
          title={t('grpc.generateExampleHint')} onClick={() => summary && onMessageChange(summary.inputTemplate)}>
          {t('grpc.generateExample')}
        </Button>
        {(streamsFromClient || stream?.accepting) && <>
          <span className="rw-grpc-message-state" role="status">
            {isSending ? t(stream?.accepting ? 'grpc.sendingOpen' : 'grpc.waitingForResponse') : ''}
          </span>
          <Button size="sm" variant="ghost" disabled={!stream?.accepting || stream.busy} onClick={onCloseSend}>
            {t('grpc.closeSend')}
          </Button>
          <Button size="sm" disabled={!stream?.accepting || stream.busy} onClick={onSendMessage}>
            {t('grpc.sendMessage')}
          </Button>
        </>}
      </div>
    </div>
  )
}
