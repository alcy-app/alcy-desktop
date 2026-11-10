import { useEffect, useId, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ResponseBodyEncoding, ResponseBodyOutput, ResponseHeader } from '../../../bindings/execute-graphql-request'
import { readResponseBodyChunk } from '../../../bindings/read-response-body-chunk'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { ChevronRightIcon } from '../../../shared/ui/icons'
import { contentTypeOf, detectBodyMode } from '../response-body-mode'
import type { ResponseBodyMode } from '../response-body-mode'
import { ResponseCodeView } from './ResponseCodeView'
import type { ResponseCodeLanguage } from './ResponseCodeView'
import type { JsonPathSegment } from '../json-value-index'
import type { ValueMonitorDto } from '../../../bindings/list-value-monitors'
import type { EditorSlot } from '../editor-bridge'
import type { ResponseExcerpt } from '../screenshot/response-excerpt'

/** Active value monitors and a callback reporting how many values failed. */
export interface ResponseBodyMonitor {
  monitors: ValueMonitorDto[]
  onFailedCount: (count: number | null) => void
}

interface ResponseBodyProps {
  body: ResponseBodyOutput
  bodyEncoding: ResponseBodyEncoding
  headers: ResponseHeader[]
  /** Shares the selected format with actions outside the body view. */
  formatControl?: { value: ResponseBodyMode; onChange: (format: ResponseBodyMode) => void }
  /** Allows capturing JSON body values for the post-response script. */
  onCaptureValue?: (path: JsonPathSegment[]) => void
  monitor?: ResponseBodyMonitor | null
  /** Editor slot for the agent (ADR 0064); only the workbench response sets it. */
  agentSlot?: EditorSlot
  /** Keeps the code view's position and search across remounts (see `ResponseCodeView`). */
  viewMemoryKey?: string
  /** When present, a selection in the code view can be shared as an image. */
  onShareSelection?: (excerpt: ResponseExcerpt) => void
}

const FORMAT_OPTIONS: ResponseBodyMode[] = ['json', 'xml', 'html', 'text']

function codeLanguageFor(format: ResponseBodyMode): ResponseCodeLanguage {
  if (format === 'json') return 'json'
  if (format === 'xml') return 'xml'
  return 'none'
}

/**
 * `sandbox=""` (without any `allow-*` tokens) treats content as an opaque
 * origin without scripts, forms, top navigation or popups. Third-party HTML
 * never gets access to the app's IPC or `window`. See ADR 0008.
 */
function HtmlPreview({ body }: { body: string }) {
  const { t } = useLanguage()
  return <iframe className="rw-html-preview" srcDoc={body} sandbox="" referrerPolicy="no-referrer" title={t('response.bodyPreviewTitle')} />
}

/** Builds a data URI from bytes already encoded as base64 by the backend (ADR 0009), without another IPC call. */
function ImagePreview({ base64, contentType }: { base64: string; contentType: string }) {
  const { t } = useLanguage()
  return <img className="rw-image-preview" src={`data:${contentType};base64,${base64}`} alt={t('response.bodyImageAlt')} />
}

/**
 * Routes available text (the entire inline body or accumulated windowed
 * chunks) to the selected display format. `ResponseCodeView` (CodeMirror 6)
 * handles JSON/XML formatting, highlighting and virtualization.
 */
function TextBodyView({
  text,
  selectedFormat,
  htmlPreview,
  partial = false,
  onCaptureValue,
  monitor,
  agentSlot,
  viewMemoryKey,
  onShareSelection,
}: {
  text: string
  selectedFormat: ResponseBodyMode
  htmlPreview: boolean
  /** `text` is incomplete: a windowed body still has pending chunks. */
  partial?: boolean
  onCaptureValue?: (path: JsonPathSegment[]) => void
  monitor?: ResponseBodyMonitor | null
  agentSlot?: EditorSlot
  viewMemoryKey?: string
  onShareSelection?: (excerpt: ResponseExcerpt) => void
}) {
  if (selectedFormat === 'html' && htmlPreview) return <HtmlPreview body={text} />
  return (
    <ResponseCodeView
      text={text}
      language={selectedFormat === 'html' ? 'none' : codeLanguageFor(selectedFormat)}
      partial={selectedFormat === 'html' ? false : partial}
      onCaptureValue={selectedFormat === 'html' ? undefined : onCaptureValue}
      monitors={monitor?.monitors ?? null}
      onMonitorFailedCount={monitor?.onFailedCount}
      agentSlot={agentSlot}
      viewMemoryKey={viewMemoryKey}
      onShareSelection={onShareSelection}
    />
  )
}

const FORMAT_LABEL_KEY: Record<ResponseBodyMode, 'response.formatJson' | 'response.formatXml' | 'response.formatHtml' | 'response.formatText'> = {
  json: 'response.formatJson',
  xml: 'response.formatXml',
  html: 'response.formatHtml',
  text: 'response.formatText',
}

/**
 * Single format selector — replaces the separate formatted/raw and
 * rendered/code toggles of specs 0034/0035. Only the current format shows;
 * the trigger slides the other ones out beside it. Every format stays
 * available even when automatic detection (`detectBodyMode`) found `text`:
 * the user can force JSON/XML/HTML when they know more about the response
 * than the detection does. Also applies to `windowed` bodies (spec 0039).
 */
function FormatSelector({ value, onChange }: { value: ResponseBodyMode; onChange: (value: ResponseBodyMode) => void }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionsId = useId()
  const currentLabel = t(FORMAT_LABEL_KEY[value])

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  return (
    <div
      role="group"
      aria-label={t('response.formatSelectorLabel')}
      className={`rw-format-switch${open ? ' rw-format-switch--open' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          close(true)
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="rw-format-switch-current"
        aria-label={t('response.formatSwitchAria', { format: currentLabel })}
        aria-expanded={open}
        aria-controls={optionsId}
        onClick={() => setOpen((current) => !current)}
      >
        {currentLabel}
        <ChevronRightIcon size={12} className="rw-format-switch-chevron" />
      </button>
      {/* Collapsed options stay in the DOM so the width can animate; `inert`
          keeps them out of the tab order and the accessibility tree. */}
      <div id={optionsId} className="rw-format-switch-options" inert={!open}>
        <div className="rw-format-switch-options-inner">
          {FORMAT_OPTIONS.filter((format) => format !== value).map((format) => (
            <button
              key={format}
              type="button"
              className="rw-format-switch-option"
              onClick={(event) => {
                onChange(format)
                // Focus returns to the trigger only for keyboard activation
                // (`detail === 0`): moved by script after a mouse click, it
                // would show the keyboard focus ring.
                close(event.detail === 0)
              }}
            >
              {t(FORMAT_LABEL_KEY[format])}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Only used for HTML: toggles between the rendered preview (ADR 0008) and source. */
function PreviewToggle({ isOn, onToggle }: { isOn: boolean; onToggle: () => void }) {
  const { t } = useLanguage()
  return (
    <Button variant="ghost" aria-pressed={isOn} onClick={onToggle}>
      {t('response.previewToggle')}
    </Button>
  )
}

type ChunkResult = { ok: true; chunk: string; nextOffset: number | null } | { ok: false }

async function fetchChunk(handle: string, offset: number): Promise<ChunkResult> {
  const result = await readResponseBodyChunk({ handle, offset })
  if (!result.ok) return { ok: false }
  return { ok: true, chunk: result.value.chunk, nextOffset: result.value.nextOffset }
}

interface DrainSetters {
  setText: Dispatch<SetStateAction<string>>
  setNextOffset: Dispatch<SetStateAction<number | null>>
  setLoadError: Dispatch<SetStateAction<boolean>>
}

/** Minimum interval between displayed text updates while fetching chunks sequentially. */
const DRAIN_PUBLISH_INTERVAL_MS = 300

/**
 * Fetches sequentially from `startOffset`. Updates displayed text after the
 * first chunk, at most every `DRAIN_PUBLISH_INTERVAL_MS`, and at completion.
 * Updating after every chunk used to copy, compare and format every growing
 * intermediate version in full. Publishes `text` and `nextOffset` together:
 * if a fetch fails, available text is published and the offset stays where
 * it stopped, so manual or automatic retries neither repeat nor lose chunks.
 *
 * Defined at module scope with explicit setters to keep its identity stable
 * and dependencies explicit, avoiding the local closure pattern flagged by
 * `react-hooks/set-state-in-effect` when called from `useEffect`.
 */
async function drainFrom(handle: string, startOffset: number, isCancelled: () => boolean, setters: DrainSetters): Promise<void> {
  let offset = startOffset
  let pending: string[] = []
  let lastPublishedAt = Number.NEGATIVE_INFINITY
  const publish = (nextOffset: number | null) => {
    if (pending.length === 0) return
    const batch = pending.join('')
    pending = []
    lastPublishedAt = performance.now()
    setters.setText((current) => current + batch)
    setters.setNextOffset(nextOffset)
  }

  for (;;) {
    const result = await fetchChunk(handle, offset)
    if (isCancelled()) return
    if (!result.ok) {
      publish(offset)
      setters.setLoadError(true)
      return
    }
    pending.push(result.chunk)
    if (result.nextOffset === null) {
      publish(null)
      return
    }
    offset = result.nextOffset
    if (performance.now() - lastPublishedAt >= DRAIN_PUBLISH_INTERVAL_MS) publish(offset)
  }
}

/**
 * Windowed bodies up to this total size fetch all chunks in the background
 * immediately, without requiring "show all" (spec 0040). Larger bodies keep
 * manual loading (spec 0020/0039): automatic fetching has no memory bound
 * beyond the backend cache capacity (ADR 0005), so huge responses still
 * require explicit user action.
 */
export const WINDOWED_AUTO_LOAD_MAX_BYTES = 20 * 1024 * 1024

function useWindowedBodyText(handle: string, preview: string, previewNextOffset: number | null, totalBytes: number) {
  const [text, setText] = useState(preview)
  const [nextOffset, setNextOffset] = useState(previewNextOffset)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [isAutoLoading, setIsAutoLoading] = useState(
    () => previewNextOffset !== null && totalBytes <= WINDOWED_AUTO_LOAD_MAX_BYTES,
  )

  const handleLoadMore = async () => {
    if (nextOffset === null) return
    setIsLoading(true)
    setLoadError(false)

    const result = await fetchChunk(handle, nextOffset)
    if (result.ok) {
      setText((current) => current + result.chunk)
      setNextOffset(result.nextOffset)
    } else {
      setLoadError(true)
    }

    setIsLoading(false)
  }

  const handleLoadAll = async () => {
    if (nextOffset === null) return
    setIsLoading(true)
    setLoadError(false)
    await drainFrom(handle, nextOffset, () => false, { setText, setNextOffset, setLoadError })
    setIsLoading(false)
  }

  useEffect(() => {
    if (previewNextOffset === null || totalBytes > WINDOWED_AUTO_LOAD_MAX_BYTES) return

    let cancelled = false
    void drainFrom(handle, previewNextOffset, () => cancelled, { setText, setNextOffset, setLoadError }).then(() => {
      if (!cancelled) setIsAutoLoading(false)
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for this response's initial preview; handleLoadMore/handleLoadAll handle subsequent fetches outside this effect.
  }, [handle])

  return { text, nextOffset, isLoading, loadError, isAutoLoading, handleLoadMore, handleLoadAll }
}

interface WindowedTextBodyProps {
  handle: string
  preview: string
  previewNextOffset: number | null
  totalBytes: number
  selectedFormat: ResponseBodyMode
  htmlPreview: boolean
  onCaptureValue?: (path: JsonPathSegment[]) => void
  monitor?: ResponseBodyMonitor | null
  agentSlot?: EditorSlot
  viewMemoryKey?: string
  onShareSelection?: (excerpt: ResponseExcerpt) => void
}

function WindowedTextBody({
  handle,
  preview,
  previewNextOffset,
  totalBytes,
  selectedFormat,
  htmlPreview,
  onCaptureValue,
  monitor,
  agentSlot,
  viewMemoryKey,
  onShareSelection,
}: WindowedTextBodyProps) {
  const { t } = useLanguage()
  const { text, nextOffset, isLoading, loadError, isAutoLoading, handleLoadMore, handleLoadAll } = useWindowedBodyText(
    handle,
    preview,
    previewNextOffset,
    totalBytes,
  )

  return (
    <>
      {isAutoLoading && <p className="rw-status-message rw-code-block-notice">{t('response.bodyAutoLoadingNotice')}</p>}
      {!isAutoLoading && nextOffset !== null && <p className="rw-status-message rw-code-block-notice">{t('response.bodyChunkedNotice')}</p>}
      <TextBodyView
        text={text}
        selectedFormat={selectedFormat}
        htmlPreview={htmlPreview}
        partial={nextOffset !== null}
        onCaptureValue={onCaptureValue}
        monitor={monitor}
        agentSlot={agentSlot}
        viewMemoryKey={viewMemoryKey}
        onShareSelection={onShareSelection}
      />
      {!isAutoLoading && nextOffset !== null && (
        <div className="rw-code-block-actions">
          <Button variant="ghost" disabled={isLoading} onClick={() => void handleLoadMore()}>
            {t('response.bodyLoadMore')}
          </Button>
          <button type="button" className="rw-link-button" disabled={isLoading} onClick={() => void handleLoadAll()}>
            {t('response.bodyShowAll')}
          </button>
        </div>
      )}
      {loadError && <p className="rw-status-message rw-code-block-notice">{t('response.bodyLoadError')}</p>}
    </>
  )
}

interface WindowedImageProps {
  handle: string
  contentType: string
  preview: string
  previewNextOffset: number | null
}

/**
 * Incomplete base64 cannot be decoded or previewed as an image. Collects all
 * chunks after an explicit click (like "show all" in `useWindowedBodyText`)
 * before mounting the image.
 */
function WindowedImage({ handle, contentType, preview, previewNextOffset }: WindowedImageProps) {
  const { t } = useLanguage()
  const [base64, setBase64] = useState<string | null>(previewNextOffset === null ? preview : null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const handleLoad = async () => {
    setIsLoading(true)
    setLoadError(false)

    let offset = previewNextOffset
    let accumulated = preview
    while (offset !== null) {
      const result = await fetchChunk(handle, offset)
      if (!result.ok) {
        setLoadError(true)
        setIsLoading(false)
        return
      }
      accumulated += result.chunk
      offset = result.nextOffset
    }

    setBase64(accumulated)
    setIsLoading(false)
  }

  if (base64 !== null) {
    return <ImagePreview base64={base64} contentType={contentType} />
  }

  return (
    <div className="rw-code-block-actions">
      <Button variant="ghost" disabled={isLoading} onClick={() => void handleLoad()}>
        {t('response.bodyLoadImage')}
      </Button>
      {loadError && <p className="rw-status-message rw-code-block-notice">{t('response.bodyLoadError')}</p>}
    </div>
  )
}

export function ResponseBody({ body, bodyEncoding, headers, formatControl, onCaptureValue, monitor, agentSlot, viewMemoryKey, onShareSelection }: ResponseBodyProps) {
  const [localFormat, setLocalFormat] = useState<ResponseBodyMode>(() =>
    formatControl?.value ?? (bodyEncoding === 'text' ? detectBodyMode(headers, body.kind === 'inline' ? body.body : body.preview) : 'text'),
  )
  const selectedFormat = formatControl?.value ?? localFormat
  const [htmlPreview, setHtmlPreview] = useState(true)

  // The backend determines `bodyEncoding` using the actual response Content-Type
  // (ADR 0009), which takes precedence over frontend format selection.
  if (bodyEncoding === 'base64') {
    const contentType = contentTypeOf(headers) ?? 'image/*'
    if (body.kind === 'windowed') {
      return (
        <div className="rw-code-block-wrapper">
          <WindowedImage
            key={body.handle}
            handle={body.handle}
            contentType={contentType}
            preview={body.preview}
            previewNextOffset={body.previewNextOffset}
          />
        </div>
      )
    }
    return <ImagePreview base64={body.body} contentType={contentType} />
  }

  const toolbar = (
    <div className="rw-response-format-toolbar">
      <FormatSelector value={selectedFormat} onChange={formatControl?.onChange ?? setLocalFormat} />
      {selectedFormat === 'html' && <PreviewToggle isOn={htmlPreview} onToggle={() => setHtmlPreview((current) => !current)} />}
    </div>
  )

  if (body.kind === 'windowed') {
    return (
      <div className="rw-code-block-wrapper">
        {toolbar}
        {/* Accumulated text belongs to this body; another handle (tab or send)
            starts from its own preview. */}
        <WindowedTextBody
          key={body.handle}
          handle={body.handle}
          preview={body.preview}
          previewNextOffset={body.previewNextOffset}
          totalBytes={body.totalBytes}
          selectedFormat={selectedFormat}
          htmlPreview={htmlPreview}
          onCaptureValue={onCaptureValue}
          monitor={monitor}
          agentSlot={agentSlot}
          viewMemoryKey={viewMemoryKey}
          onShareSelection={onShareSelection}
        />
      </div>
    )
  }

  return (
    <div className="rw-code-block-wrapper">
      {toolbar}
      <TextBodyView
        text={body.body}
        selectedFormat={selectedFormat}
        htmlPreview={htmlPreview}
        onCaptureValue={onCaptureValue}
        monitor={monitor}
        agentSlot={agentSlot}
        viewMemoryKey={viewMemoryKey}
        onShareSelection={onShareSelection}
      />
    </div>
  )
}
