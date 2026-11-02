import { useId, useState } from 'react'
import type { ExecuteWebSocketRequestOutput } from '../../../bindings/execute-websocket-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Tabs } from '../../../shared/ui/Tabs'
import type { JsonPathSegment } from '../json-value-index'
import type { WebSocketStreamState } from '../websocket-stream'
import { FailureMessage } from './FailureMessage'
import { ResponseBody, type ResponseBodyMonitor } from './ResponseBody'
import { ResponseHeadersList } from './ResponseHeadersList'
import { ScriptTestList } from './ScriptTestList'
import { WebSocketTimeline } from './WebSocketTimeline'

type Tab = 'messages' | 'headers' | 'tests' | 'body'

interface WebSocketResponseViewProps {
  stream: WebSocketStreamState
  result: ExecuteWebSocketRequestOutput | null
  error?: string
  onCaptureValue?: (path: JsonPathSegment[]) => void
  monitor?: ResponseBodyMonitor | null
}

/** A connection's messages while it is open, then also the handshake, the
 * tests and the received messages as a body once it ends (spec 0140). */
export function WebSocketResponseView({ stream, result, error, onCaptureValue, monitor }: WebSocketResponseViewProps) {
  const { t } = useLanguage()
  const id = useId()
  const rejected = result?.close.closedBy === 'rejected'
  const [tab, setTab] = useState<Tab>(rejected ? 'body' : 'messages')
  const opened = stream.events.find((event) => event.type === 'opened')
  const headers = result?.headers ?? (opened?.type === 'opened' ? opened.headers : [])
  const tests = result?.testResults ?? []
  const tabs = [
    ...(rejected ? [] : [{ id: 'messages' as const, label: t('websocket.messages') }]),
    { id: 'headers' as const, label: t('websocket.handshake'), badge: headers.length },
    ...(tests.length ? [{ id: 'tests' as const, label: t('websocket.tests'), badge: tests.length }] : []),
    ...(result ? [{ id: 'body' as const, label: rejected ? t('websocket.rejectedBody') : t('websocket.receivedBody') }] : []),
  ]
  const visibleTab = tabs.some((item) => item.id === tab) ? tab : tabs[0].id
  return (
    <div className="rw-grpc-response">
      <Tabs tabs={tabs} activeTab={visibleTab} onChange={setTab} ariaLabel={t('response.tabsLabel')} idPrefix={id} />
      {error && <FailureMessage className="rw-grpc-response-error" summary={error} detail={null} />}
      {tabs.map((item) => (
        <div
          key={item.id}
          className={'rw-grpc-response-panel' + (item.id === 'messages' ? ' rw-grpc-response-panel--messages' : '')}
          role="tabpanel"
          id={`tabpanel-${id}${item.id}`}
          aria-labelledby={`tab-${id}${item.id}`}
          hidden={visibleTab !== item.id}
        >
          {item.id === 'messages' && <WebSocketTimeline stream={stream} />}
          {item.id === 'headers' && <ResponseHeadersList headers={headers} />}
          {item.id === 'tests' && <ScriptTestList tests={tests} />}
          {item.id === 'body' && result && (
            <ResponseBody
              body={result.body}
              bodyEncoding="text"
              headers={rejected ? result.headers : [{ name: 'content-type', value: 'application/json' }]}
              onCaptureValue={onCaptureValue}
              monitor={monitor}
            />
          )}
        </div>
      ))}
    </div>
  )
}
