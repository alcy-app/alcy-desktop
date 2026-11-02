import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, FocusEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import type { HttpMethodInput } from '../../../bindings/execute-rest-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Button } from '../../../shared/ui/Button'
import { LoadingBar } from '../../../shared/ui/LoadingBar'
import { MenuItem } from '../../../shared/ui/Menu'
import { ChevronDownIcon, Spinner } from '../../../shared/ui/icons'
import { Select } from '../../../shared/ui/Select'
import { isShellCommand } from '../shell-paste-import'
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
  /** Send and save the response body to a file on success. */
  onSendAndDownload: () => void
  onCancel: () => void
  isSending: boolean
  environmentVariables: EnvironmentVariableDto[]
  routeParams?: RouteParamEntry[]
  onUpdateRouteParamValue?: (id: string, value: string) => void
  /** Documentation for path parameters used in the URL as variable placeholders. */
  pathParameterDocs?: Record<string, VariableDoc>
  /** Pasted curl/wget/grpcurl replaces an empty or fully selected URL with an imported request. */
  onPasteCommand?: (command: string) => void
  /** Lock the field while a pasted command is being converted. */
  isImportingCommand?: boolean
  /** Service/method picker shown in place of the HTTP method for gRPC. */
  grpcMethodPicker?: ReactNode
  /** Schema source and service refresh at the end of the gRPC URL field. */
  grpcSchemaControls?: ReactNode
  /** WebSocket only: whether the connection is open, so the action becomes Disconnect. */
  websocketOpen?: boolean
  /** WebSocket only: closes the open connection normally. */
  onDisconnect?: () => void
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
  grpcMethodPicker,
  grpcSchemaControls,
  websocketOpen = false,
  onDisconnect,
}: EndpointBarProps) {
  const { t } = useLanguage()
  const methodClass =
    protocol === 'rest'
      ? `rw-endpoint-method--${method}`
      : protocol === 'websocket'
        ? 'rw-endpoint-method--websocket'
        : 'rw-endpoint-method--graphql'
  // HTTP options (save the response to a file) do not apply to gRPC or WebSocket.
  const sendOnly = protocol === 'grpc' || protocol === 'websocket'

  // Import only when pasting would replace the entire URL (empty or fully selected).
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
        {protocol === 'grpc' ? (
          grpcMethodPicker
        ) : protocol === 'rest' ? (
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
            {protocol === 'websocket' ? 'WS' : 'GraphQL'}
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
        {protocol === 'grpc' && grpcSchemaControls}
      </div>
      {isSending && protocol === 'websocket' && websocketOpen ? (
        <Button className="rw-endpoint-action" variant="danger" size="sm" onClick={onDisconnect ?? onCancel}>
          {t('websocket.disconnect')}
        </Button>
      ) : isSending ? (
        <Button className="rw-endpoint-action" variant="danger" size="sm" onClick={onCancel} aria-busy>
          <span className="rw-endpoint-action-content">
            <Spinner size={13} />
            <span className="rw-endpoint-action-label">{t('common.cancel')}</span>
          </span>
        </Button>
      ) : (
        <div className={`rw-endpoint-send-group${sendOnly ? ' rw-endpoint-send-group--grpc' : ''}`}>
          <Button className={`rw-endpoint-action${sendOnly ? '' : ' rw-endpoint-action--split'}`} variant="primary" size="sm" onClick={onSend} disabled={isImportingCommand}>
            {protocol === 'websocket' ? t('websocket.connect') : t('endpointBar.send')}
          </Button>
          {/* Saving the response to a file is an HTTP option. */}
          {!sendOnly && <SendOptionsMenu onSendAndDownload={onSendAndDownload} disabled={isImportingCommand} />}
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

/** Send options arrow with a fixed-position menu portaled below it, like ShareMenu. */
function SendOptionsMenu({ onSendAndDownload, disabled = false }: { onSendAndDownload: () => void; disabled?: boolean }) {
  const { t } = useLanguage()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const open = position !== null

  // Disabling the control (e.g. during command import) also closes its menu.
  if (disabled && open) setPosition(null)

  useEffect(() => {
    if (!open) return
    // Focus after menuRef attaches; autoFocus could blur the button and close the menu first.
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    // Close on resize because the menu uses fixed viewport coordinates.
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

  // Portal events bubble through React, but the menu is outside the host in the DOM.
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
