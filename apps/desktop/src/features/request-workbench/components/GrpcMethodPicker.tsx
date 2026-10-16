import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { GrpcMethodKind } from '../../../bindings/load-grpc-schema'
import { useLanguage } from '../../../shared/i18n/use-language'
import type { TranslationKey } from '../../../shared/i18n/translations'
import { ChevronDownIcon, Spinner } from '../../../shared/ui/icons'
import { describeError } from '../response-summary'
import { shortServiceName } from '../grpc-schema'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
import './grpc.css'

const KIND_LABEL: Record<GrpcMethodKind, TranslationKey> = {
  unary: 'grpc.kind.unary',
  serverStreaming: 'grpc.kind.serverStreaming',
  clientStreaming: 'grpc.kind.clientStreaming',
  bidiStreaming: 'grpc.kind.bidiStreaming',
}

/** Arrow per call kind: what streams, if anything. */
const KIND_GLYPH: Record<GrpcMethodKind, string> = {
  unary: '→',
  serverStreaming: '↓',
  clientStreaming: '↑',
  bidiStreaming: '⇅',
}

interface Option {
  service: string
  method: string
  kind: GrpcMethodKind
}

interface GrpcMethodPickerProps {
  schema: GrpcSchemaLoadState
  service: string
  method: string
  onSelect: (service: string, method: string) => void
  /** Loads the services; `true` asks the server again. */
  onLoad: (forceRefresh: boolean) => void
}

const POPUP_GAP_PX = 4
const POPUP_WIDTH_PX = 360

/** Chooses the service and method a gRPC request calls (spec 0129): a
 * searchable list grouped by service, loaded on first open. */
export function GrpcMethodPicker({ schema, service, method, onSelect, onLoad }: GrpcMethodPickerProps) {
  const { t } = useLanguage()
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const isOpen = position !== null

  const options = useMemo<Option[]>(() => {
    if (schema.status !== 'success') return []
    const needle = query.trim().toLowerCase()
    return schema.schema.services.flatMap((candidate) =>
      candidate.methods
        .filter((entry) => needle === '' || `${candidate.name}/${entry.name}`.toLowerCase().includes(needle))
        .map((entry) => ({ service: candidate.name, method: entry.name, kind: entry.kind })),
    )
  }, [schema, query])

  const selectedKind =
    schema.status === 'success'
      ? schema.schema.services.find((candidate) => candidate.name === service)?.methods.find((entry) => entry.name === method)?.kind
      : undefined

  const close = () => {
    setPosition(null)
    setQuery('')
  }

  const open = () => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_WIDTH_PX - 8))
    setPosition({ left, top: rect.bottom + POPUP_GAP_PX })
    setActiveIndex(0)
    if (schema.status === 'idle') onLoad(false)
  }

  const choose = (option: Option | undefined) => {
    if (!option) return
    onSelect(option.service, option.method)
    close()
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      close()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', close)
    }
  }, [isOpen])

  // The popup exists to pick a method: typing filters it right away.
  useEffect(() => {
    if (isOpen) searchRef.current?.focus()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    popupRef.current?.querySelector(`#${CSS.escape(`${listId}-${activeIndex}`)}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [isOpen, activeIndex, listId])

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((index) => Math.min(index + 1, options.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((index) => Math.max(index - 1, 0))
        break
      case 'Enter':
        event.preventDefault()
        choose(options[activeIndex])
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close()
        triggerRef.current?.focus()
        break
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="rw-endpoint-method rw-endpoint-method--grpc rw-grpc-picker"
        aria-label={t('grpc.methodPickerLabel')}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => (isOpen ? close() : open())}
      >
        {method ? (
          <span className="rw-grpc-picker-value" title={`${service}/${method}`}>
            {selectedKind && <span aria-hidden="true">{KIND_GLYPH[selectedKind]}</span>}
            <span className="rw-grpc-picker-service">{shortServiceName(service)}</span>
            <span className="rw-grpc-picker-method">{method}</span>
          </span>
        ) : (
          <span className="rw-grpc-picker-placeholder">{t('grpc.chooseMethod')}</span>
        )}
        <ChevronDownIcon size={12} />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={popupRef}
            className="rw-grpc-popup"
            role="dialog"
            aria-label={t('grpc.methodPickerLabel')}
            style={{ left: position.left, top: position.top, width: POPUP_WIDTH_PX }}
          >
            <div className="rw-grpc-popup-search">
              <input
                ref={searchRef}
                className="ui-input"
                value={query}
                placeholder={t('grpc.searchMethods')}
                aria-label={t('grpc.searchMethods')}
                aria-controls={listId}
                aria-activedescendant={options.length > 0 ? `${listId}-${activeIndex}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={onSearchKeyDown}
              />

            </div>
            {schema.status === 'loading' && (
              <p className="rw-grpc-popup-status" role="status">
                <Spinner size={12} />
                {t('grpc.loadingServices')}
              </p>
            )}
            {schema.status === 'error' && (
              <p className="rw-grpc-popup-status rw-grpc-popup-status--error" role="alert">
                {describeError(t, schema.error)}
              </p>
            )}
            {schema.status === 'idle' && <p className="rw-grpc-popup-status">{t('grpc.loadingServices')}</p>}
            {schema.status === 'success' && options.length === 0 && (
              <p className="rw-grpc-popup-status">
                {schema.schema.services.length === 0 ? t('grpc.noServices') : t('grpc.noMatches')}
              </p>
            )}
            {options.length > 0 && (
              <ul id={listId} className="rw-grpc-popup-list" role="listbox" aria-label={t('grpc.methodPickerLabel')}>
                {options.map((option, index) => {
                  const header =
                    index === 0 || options[index - 1].service !== option.service ? (
                      <li key={`group-${option.service}`} role="presentation" className="rw-grpc-popup-group">
                        {option.service}
                      </li>
                    ) : null
                  const selected = option.service === service && option.method === method
                  return [
                    header,
                    <li
                      key={`${option.service}/${option.method}`}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={selected}
                      className={[
                        'rw-grpc-popup-option',
                        index === activeIndex ? 'rw-grpc-popup-option--active' : null,
                        selected ? 'rw-grpc-popup-option--selected' : null,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option)}
                    >
                      <span className="rw-grpc-popup-method">{option.method}</span>
                      <span className="rw-grpc-popup-kind">
                        <span aria-hidden="true">{KIND_GLYPH[option.kind]}</span> {t(KIND_LABEL[option.kind])}
                      </span>
                    </li>,
                  ]
                })}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
