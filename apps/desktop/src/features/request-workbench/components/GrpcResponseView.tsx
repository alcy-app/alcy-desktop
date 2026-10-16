import { useId, useState } from 'react'
import type { ExecuteGrpcRequestOutput } from '../../../bindings/execute-grpc-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Tabs } from '../../../shared/ui/Tabs'
import type { GrpcStreamState } from '../grpc-stream'
import type { JsonPathSegment } from '../json-value-index'
import { FailureMessage } from './FailureMessage'
import { GrpcTimeline } from './GrpcTimeline'
import { ResponseBody, type ResponseBodyMonitor } from './ResponseBody'
import { ResponseHeadersList } from './ResponseHeadersList'
import { ScriptTestList } from './ScriptTestList'

type Tab = 'messages' | 'headers' | 'trailers' | 'tests' | 'body'
interface GrpcResponseViewProps {
  stream: GrpcStreamState
  result: ExecuteGrpcRequestOutput | null
  error?: string
  onCaptureValue?: (path: JsonPathSegment[]) => void
  monitor?: ResponseBodyMonitor | null
}

/** Keep the same response sections throughout a live call and after completion. */
export function GrpcResponseView({ stream, result, error, onCaptureValue, monitor }: GrpcResponseViewProps) {
  const { t } = useLanguage()
  const id = useId()
  const [tab, setTab] = useState<Tab>('messages')
  const headers = result?.headers ?? stream.events.findLast((event) => event.type === 'headers')?.metadata ?? []
  const finished = stream.events.findLast((event) => event.type === 'finished')
  const trailers = result?.trailers ?? (finished?.type === 'finished' ? finished.trailers : [])
  const tests = result?.testResults ?? []
  const tabs = [
    { id: 'messages' as const, label: t('grpc.messages') },
    { id: 'headers' as const, label: t('grpc.metadata'), badge: headers.length },
    { id: 'trailers' as const, label: t('grpc.trailers'), badge: trailers.length },
    ...(tests.length ? [{ id: 'tests' as const, label: t('grpc.tests'), badge: tests.length }] : []),
    ...(result ? [{ id: 'body' as const, label: t('grpc.fullBody') }] : []),
  ]
  const visibleTab = tabs.some((item) => item.id === tab) ? tab : 'messages'
  return (
    <div className="rw-grpc-response">
      <Tabs tabs={tabs} activeTab={visibleTab} onChange={setTab} ariaLabel={t('response.tabsLabel')} idPrefix={id} />
      {error && <FailureMessage className="rw-grpc-response-error" summary={error} detail={null} />}
      {tabs.map((item) => (
        <div key={item.id} className={'rw-grpc-response-panel' + (item.id === 'messages' ? ' rw-grpc-response-panel--messages' : '')}
          role="tabpanel" id={`tabpanel-${id}${item.id}`} aria-labelledby={`tab-${id}${item.id}`} hidden={visibleTab !== item.id}>
          {item.id === 'messages' && <GrpcTimeline stream={stream} pending={!result && !error} />}
          {item.id === 'headers' && <ResponseHeadersList headers={headers} />}
          {item.id === 'trailers' && <ResponseHeadersList headers={trailers} />}
          {item.id === 'tests' && <ScriptTestList tests={tests} />}
          {item.id === 'body' && result && <ResponseBody body={result.body} bodyEncoding="text" headers={[{ name: 'content-type', value: 'application/json' }]} onCaptureValue={onCaptureValue} monitor={monitor} />}
        </div>
      ))}
    </div>
  )
}
