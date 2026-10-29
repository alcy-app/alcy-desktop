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

/** Monitor de valores ligado: monitores a aplicar e onde reportar quantos valores reprovaram. */
export interface ResponseBodyMonitor {
  monitors: ValueMonitorDto[]
  onFailedCount: (count: number | null) => void
}

interface ResponseBodyProps {
  body: ResponseBodyOutput
  bodyEncoding: ResponseBodyEncoding
  headers: ResponseHeader[]
  /** Quando presente, valores JSON do corpo podem ser capturados para o script de pós-resposta. */
  onCaptureValue?: (path: JsonPathSegment[]) => void
  monitor?: ResponseBodyMonitor | null
  /** Editor slot for the agent (ADR 0064); only the workbench response sets it. */
  agentSlot?: EditorSlot
}

const FORMAT_OPTIONS: ResponseBodyMode[] = ['json', 'xml', 'html', 'text']

function codeLanguageFor(format: ResponseBodyMode): ResponseCodeLanguage {
  if (format === 'json') return 'json'
  if (format === 'xml') return 'xml'
  return 'none'
}

/**
 * `sandbox=""` (sem nenhum token `allow-*`) trata o conteúdo como uma
 * origem opaca sem script, formulário, navegação de topo ou popup — HTML
 * de terceiros nunca ganha acesso a IPC/`window` do app. Ver ADR 0008.
 */
function HtmlPreview({ body }: { body: string }) {
  const { t } = useLanguage()
  return <iframe className="rw-html-preview" srcDoc={body} sandbox="" referrerPolicy="no-referrer" title={t('response.bodyPreviewTitle')} />
}

/** Imagem a partir de bytes já em base64 (backend, ver ADR 0009) — monta uma data URI, sem passar pelo IPC de novo. */
function ImagePreview({ base64, contentType }: { base64: string; contentType: string }) {
  const { t } = useLanguage()
  return <img className="rw-image-preview" src={`data:${contentType};base64,${base64}`} alt={t('response.bodyImageAlt')} />
}

/**
 * Roteia o texto já disponível (corpo `inline` inteiro, ou o acumulado até
 * agora de um corpo `windowed`) para a exibição correta conforme o formato
 * selecionado. Formatação/destaque de JSON e XML, e virtualização por
 * tamanho, ficam a cargo de `ResponseCodeView` (CodeMirror 6).
 */
function TextBodyView({
  text,
  selectedFormat,
  htmlPreview,
  partial = false,
  onCaptureValue,
  monitor,
  agentSlot,
}: {
  text: string
  selectedFormat: ResponseBodyMode
  htmlPreview: boolean
  /** `text` ainda não é o corpo inteiro (corpo `windowed` com chunks pendentes). */
  partial?: boolean
  onCaptureValue?: (path: JsonPathSegment[]) => void
  monitor?: ResponseBodyMonitor | null
  agentSlot?: EditorSlot
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

/** Só relevante para `selectedFormat === 'html'` — alterna entre preview renderizado (ADR 0008) e código-fonte. */
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

/** Intervalo mínimo entre duas atualizações do texto exibido durante uma busca em sequência. */
const DRAIN_PUBLISH_INTERVAL_MS = 300

/**
 * Busca em sequência a partir de `startOffset`. O texto exibido é
 * atualizado no primeiro chunk e depois no máximo a cada
 * `DRAIN_PUBLISH_INTERVAL_MS` (e no fim): atualizar a cada chunk fazia cada
 * versão intermediária, cada vez maior, ser copiada, comparada e formatada
 * inteira. `text` e `nextOffset` são sempre publicados juntos — se uma busca
 * falhar no meio do caminho, o que já chegou é publicado e `nextOffset` fica
 * exatamente onde parou, e um retry (manual ou automático) não refaz nem
 * perde chunks.
 *
 * Definida no módulo (não como closure dentro do hook) e recebendo os
 * setters explicitamente: chamar uma função local recriada a cada render
 * de dentro de um `useEffect` é exatamente o padrão que
 * `react-hooks/set-state-in-effect` sinaliza — no escopo do módulo, a
 * identidade da função é estável e as dependências ficam explícitas nos
 * parâmetros, não numa closure.
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
 * Corpos `windowed` até este tamanho total buscam todos os chunks sozinhos,
 * em segundo plano, assim que chegam — sem exigir clique em "mostrar
 * tudo" (spec 0040). Acima do teto, mantém o comportamento manual de
 * sempre (spec 0020/0039): buscar tudo automaticamente não tem limite
 * superior de memória além da capacidade do cache do backend (ADR 0005),
 * então uma resposta verdadeiramente enorme continua exigindo ação
 * explícita do usuário.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roda uma vez para o preview inicial desta resposta; handleLoadMore/handleLoadAll tratam buscas subsequentes fora deste efeito.
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
 * Base64 incompleto não decodifica — diferente de texto, não dá pra mostrar
 * o preview parcial como imagem. Acumula todos os chunks (mesmo laço de
 * "Mostrar tudo" de `useWindowedBodyText`) atrás de um clique explícito, e só
 * então monta a `<img>`.
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

export function ResponseBody({ body, bodyEncoding, headers, onCaptureValue, monitor, agentSlot }: ResponseBodyProps) {
  const [selectedFormat, setSelectedFormat] = useState<ResponseBodyMode>(() =>
    bodyEncoding === 'text' ? detectBodyMode(headers, body.kind === 'inline' ? body.body : body.preview) : 'text',
  )
  const [htmlPreview, setHtmlPreview] = useState(true)

  // `bodyEncoding` já veio decidido do backend (Content-Type real da
  // resposta, ver ADR 0009) — mais confiável que o frontend re-adivinhar
  // pelo corpo, então isto vem antes de qualquer seleção de formato.
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
      <FormatSelector value={selectedFormat} onChange={setSelectedFormat} />
      {selectedFormat === 'html' && <PreviewToggle isOn={htmlPreview} onToggle={() => setHtmlPreview((current) => !current)} />}
    </div>
  )

  if (body.kind === 'windowed') {
    return (
      <div className="rw-code-block-wrapper">
        {toolbar}
        {/* `key`: o texto acumulado pertence a este corpo; outro handle (outra
            aba, outro envio) começa do seu próprio preview, nunca do anterior. */}
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
      />
    </div>
  )
}
