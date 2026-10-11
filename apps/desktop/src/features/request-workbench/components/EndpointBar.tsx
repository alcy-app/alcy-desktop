import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, FocusEvent } from 'react'
import { createPortal } from 'react-dom'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { HttpMethodInput } from '../../../bindings/execute-rest-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { LoadingBar } from '../../../shared/ui/LoadingBar'
import { MenuItem } from '../../../shared/ui/Menu'
import { ChevronDownIcon, Spinner } from '../../../shared/ui/icons'
import { Select } from '../../../shared/ui/Select'
import { isShellCommand } from '../curl-paste-import'
import type { RouteParamEntry, WorkbenchProtocol } from '../request-workbench.types'
import { TemplateHighlightedField } from './TemplateHighlightedField'
import type { VariableDoc } from './VariablePreviewCard'

const HTTP_METHODS: HttpMethodInput[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

interface EndpointBarProps {
  protocol: WorkbenchProtocol
  method: HttpMethodInput
  onMethodChange: (method: HttpMethodInput) => void
  endpointUrl: string
  onEndpointUrlChange: (value: string) => void
  onSend: () => void
  /** "Baixar resposta": envia e, com sucesso, grava o corpo da resposta num arquivo. */
  onSendAndDownload: () => void
  onCancel: () => void
  isSending: boolean
  environmentVariables: EnvironmentVariableDto[]
  routeParams?: RouteParamEntry[]
  onUpdateRouteParamValue?: (id: string, value: string) => void
  /** Documentação dos parâmetros de path usados na URL como `{{nome}}`. */
  pathParameterDocs?: Record<string, VariableDoc>
  /** `curl`/`wget` colado com a URL vazia ou toda selecionada: o texto não entra no campo e vira a requisição da aba. */
  onPasteCommand?: (command: string) => void
  /** Comando colado sendo convertido; o campo fica bloqueado até terminar. */
  isImportingCommand?: boolean
}

export function EndpointBar({
  protocol,
  method,
  onMethodChange,
  endpointUrl,
  onEndpointUrlChange,
  onSend,
  onSendAndDownload,
  onCancel,
  isSending,
  environmentVariables,
  routeParams,
  onUpdateRouteParamValue,
  pathParameterDocs,
  onPasteCommand,
  isImportingCommand = false,
}: EndpointBarProps) {
  const { t } = useLanguage()
  const methodClass = protocol === 'rest' ? `rw-endpoint-method--${method}` : 'rw-endpoint-method--graphql'

  // Vale com a URL vazia ou com ela inteira selecionada (Ctrl+A): nos dois
  // casos o texto colado substituiria a URL toda.
  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const replacesAll = input.selectionStart === 0 && input.selectionEnd === input.value.length
    if (!onPasteCommand || (endpointUrl.trim() !== '' && !replacesAll)) return
    const text = event.clipboardData.getData('text/plain')
    if (!isShellCommand(text)) return
    event.preventDefault()
    onPasteCommand(text)
  }

  return (
    <div className="rw-endpoint-bar">
      <div className="rw-endpoint-field" aria-busy={isImportingCommand || undefined}>
        {protocol === 'rest' ? (
          <Select
            className={`rw-endpoint-method rw-endpoint-method--select ${methodClass}`}
            aria-label={t('endpointBar.methodLabel')}
            value={method}
            onChange={(event) => onMethodChange(event.target.value as HttpMethodInput)}
          >
            {HTTP_METHODS.map((value) => (
              <option key={value} value={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </Select>
        ) : (
          <button type="button" className={`rw-endpoint-method ${methodClass}`} disabled>
            GraphQL
          </button>
        )}
        <label className="rw-visually-hidden" htmlFor="endpoint-url">
          {t('endpointBar.endpointLabel')}
        </label>
        <div className="rw-endpoint-url">
          <TemplateHighlightedField
            id="endpoint-url"
            fieldClassName="ui-input ui-input--mono rw-endpoint-input"
            value={endpointUrl}
            onChange={onEndpointUrlChange}
            variables={environmentVariables}
            variableDocs={pathParameterDocs}
            highlightRouteParams={protocol === 'rest'}
            routeParams={routeParams}
            onUpdateRouteParamValue={onUpdateRouteParamValue}
            onPaste={handlePaste}
            readOnly={isImportingCommand}
          />
          {isImportingCommand && (
            <div className="rw-endpoint-importing" role="status" aria-live="polite">
              <Spinner size={13} />
              {t('endpointBar.importingCommand')}
            </div>
          )}
        </div>
      </div>
      {isSending ? (
        <Button className="rw-endpoint-action" variant="danger" size="sm" onClick={onCancel} aria-busy>
          <Spinner size={13} />
          {t('common.cancel')}
        </Button>
      ) : (
        <div className="rw-endpoint-send-group">
          <Button className="rw-endpoint-action rw-endpoint-action--split" variant="primary" size="sm" onClick={onSend} disabled={isImportingCommand}>
            {t('endpointBar.send')}
          </Button>
          <SendOptionsMenu onSendAndDownload={onSendAndDownload} disabled={isImportingCommand} />
        </div>
      )}
      {isImportingCommand && (
        <div className="rw-endpoint-loading-bar">
          <LoadingBar />
        </div>
      )}
    </div>
  )
}

interface MenuPosition {
  top: number
  right: number
}

const MENU_GAP_PX = 4

/** Seta ao lado de "Enviar" com as outras formas de enviar. O menu vai em
 * portal, com posição fixa sob a seta (mesmo padrão do `ShareMenu`). */
function SendOptionsMenu({ onSendAndDownload, disabled = false }: { onSendAndDownload: () => void; disabled?: boolean }) {
  const { t } = useLanguage()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const open = position !== null

  // Desabilitar com o menu aberto (ex.: importação de comando) também o fecha.
  if (disabled && open) setPosition(null)

  useEffect(() => {
    if (!open) return
    // Foco inicial aqui, e não com `autoFocus`: o React focaria o item antes de
    // ligar `menuRef`, e o blur do botão fecharia o menu na hora.
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    // A posição é fixa na tela; redimensionar a janela deixaria o menu solto.
    const close = () => setPosition(null)
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [open])

  const toggle = () => {
    if (open) {
      setPosition(null)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({ top: rect.bottom + MENU_GAP_PX, right: window.innerWidth - rect.right })
  }

  // Eventos do portal sobem pela árvore do React, mas no DOM o menu fica fora do host.
  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (!event.currentTarget.contains(next) && !menuRef.current?.contains(next)) setPosition(null)
  }

  return (
    <div className="ui-menu-host" onBlur={closeOnBlur}>
      <Button
        ref={buttonRef}
        variant="primary"
        size="sm"
        className="rw-endpoint-send-options"
        aria-label={t('endpointBar.moreSendOptions')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
        disabled={disabled}
      >
        <ChevronDownIcon size={12} />
      </Button>
      {position &&
        createPortal(
          <div
            ref={menuRef}
            className="ui-menu rw-send-menu"
            role="menu"
            aria-label={t('endpointBar.moreSendOptions')}
            style={{ top: position.top, right: position.right }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setPosition(null)
                buttonRef.current?.focus()
              }
            }}
          >
            <MenuItem
              label={t('endpointBar.downloadResponse')}
              onSelect={() => {
                setPosition(null)
                onSendAndDownload()
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  )
}
