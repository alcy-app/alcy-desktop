import { useMemo } from 'react'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { findGrpcMethod, grpcMessageSchema } from '../grpc-schema'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
import { RequestBodyPanel } from './RequestBodyPanel'
import './grpc.css'

interface GrpcMessagePanelProps {
  service: string
  method: string
  message: string
  onMessageChange: (message: string) => void
  schema: GrpcSchemaLoadState
  environmentVariables: EnvironmentVariableDto[]
}

/** The request message of a gRPC call, as JSON (spec 0129): completion from
 * the method's input type once the services are loaded, and a template with
 * every field to start from. */
export function GrpcMessagePanel({ service, method, message, onMessageChange, schema, environmentVariables }: GrpcMessagePanelProps) {
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
        <Button
          variant="ghost"
          size="sm"
          disabled={!summary}
          title={t('grpc.generateExampleHint')}
          onClick={() => summary && onMessageChange(summary.inputTemplate)}
        >
          {t('grpc.generateExample')}
        </Button>
      </div>
      {streamsFromClient && (
        <p className="rw-grpc-message-note" role="note">
          {t('grpc.singleMessageNote')}
        </p>
      )}
      <RequestBodyPanel
        value={message}
        onChange={onMessageChange}
        label={t('grpc.messageLabel')}
        environmentVariables={environmentVariables}
        bodySchema={bodySchema}
      />
    </div>
  )
}
