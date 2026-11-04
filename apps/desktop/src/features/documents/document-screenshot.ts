import { toBodyState } from '../request-workbench/body-state'
import { toAuthorizationState } from '../request-workbench/authorization-state'
import { documentCall } from '../../bindings/documentation'
import type { WorkbenchAgentHost } from '../agent/agent-host'
import { buildScreenshotContent, type ScreenshotContent } from '../request-workbench/screenshot/screenshot-content'
import { layoutScreenshot } from '../request-workbench/screenshot/screenshot-layout'
import { DEFAULT_SCREENSHOT_OPTIONS } from '../request-workbench/screenshot/screenshot-options'
import { SCREENSHOT_PALETTES } from '../request-workbench/screenshot/screenshot-palette'
import { canvasToPng, createMeasure, drawScreenshot, ensureScreenshotFonts } from '../request-workbench/screenshot/screenshot-render'
import type { TranslationKey } from '../../shared/i18n/translations'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string
interface ImageSource { request: { method: string; url: string; body: string; bodyTruncated?: boolean; headers: { name: string; value: string }[] }; response: { statusCode?: number; durationMs?: number; sizeBytes?: number; body?: string; headers?: { name: string; value: string }[]; error?: string; responseOmitted?: boolean; bodyTruncated?: boolean } }

export async function captureDocumentRequest(rootPath: string, documentId: string, input: { tabId?: string; sourceId?: string; target?: 'request' | 'response' | 'both' }, host: WorkbenchAgentHost | null, t: Translate): Promise<Blob> {
  const options = { ...DEFAULT_SCREENSHOT_OPTIONS, includeImportMetadata: false, hideSensitive: true, width: 'compact' as const }
  let content: ScreenshotContent
  if (input.tabId && host) {
    const tab = host.tabs().find((tab) => tab.id === input.tabId)
    if (!tab) throw new Error('The request tab is no longer available.')
    const environment = host.environments().find((e) => e.id === host.activeEnvironmentId())
    content = buildScreenshotContent({ tab: { ...tab.content, body: toBodyState(tab.content.body), headers: tab.content.headers.map((header, i) => ({ ...header, id: `${i}` })), routeParams: (tab.content.routeParams ?? []).map((param, i) => ({ ...param, id: `${i}` })), authorization: toAuthorizationState(tab.content.authentication) }, execution: tab.execution, inheritedAuthentication: undefined, environmentVariables: environment?.variables.map((v, i) => ({ ...v, id: `${i}` })) ?? [], requestName: tab.name, environmentName: environment?.name ?? null }, options, {
      capturedAt: new Date().toLocaleString(), errorMessage: () => t('documents.executionFailed'), binaryBody: () => t('documents.binary'), emptyBody: t('documents.emptyBody'), previewOnly: () => t('documents.partial'), file: () => t('documents.file'), excerptLabel: (first, last) => `${first}–${last}`,
    })
  } else {
    if (!input.sourceId) throw new Error('Choose a request source.')
    const source = await documentCall<ImageSource>(rootPath, 'requestImage', { documentId, sourceKind: 'request', sourceId: input.sourceId })
    const r = source.response
    content = {
      header: { title: t('documents.requestEvidence'), environment: null, capturedAt: new Date().toLocaleString() },
      endpoint: { method: source.request.method, url: source.request.url },
      request: { headers: source.request.headers, body: [{ kind: 'code', label: null, language: 'json', lines: source.request.body.split('\n').slice(0, 60), omittedLines: Math.max(0, source.request.body.split('\n').length - 60), note: source.request.bodyTruncated ? t('documents.partial') : null }] },
      response: r.error ? { kind: 'error', message: r.error } : { kind: 'success', status: r.statusCode ? { statusCode: r.statusCode, tone: r.statusCode >= 400 ? 'error' : 'success', graphql: null, duration: `${r.durationMs ?? 0} ms`, size: `${r.sizeBytes ?? 0} B` } : null, headers: r.headers ?? [], body: { kind: 'code', label: null, language: 'json', lines: (r.body ?? '').split('\n').slice(0, 60), omittedLines: Math.max(0, (r.body ?? '').split('\n').length - 60), note: r.responseOmitted || r.bodyTruncated ? t('documents.partial') : null } },
    }
  }
  if (input.target === 'request') content.response = null
  if (input.target === 'response') content.request = null
  await ensureScreenshotFonts()
  const canvas = document.createElement('canvas')
  const layout = layoutScreenshot(content, options, createMeasure(canvas.getContext('2d')), { request: t('share.image.request'), response: t('share.image.response'), headers: 'Headers', body: 'Body', trailers: 'Trailers', environment: (name) => name, capturedAt: (date) => date, moreLines: (count) => t('share.image.moreLines', { count }), truncated: t('documents.partial') })
  if (!drawScreenshot(canvas, layout, SCREENSHOT_PALETTES.light)) throw new Error('The image could not be rendered.')
  return canvasToPng(canvas)
}
