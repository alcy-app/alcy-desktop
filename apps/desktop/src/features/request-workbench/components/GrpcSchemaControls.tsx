import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../../../shared/i18n/use-language'
import { IconButton } from '../../../shared/ui/IconButton'
import { ChevronDownIcon, RefreshIcon, Spinner } from '../../../shared/ui/icons'
import type { GrpcCallState } from '../collection-tree'
import type { GrpcSchemaLoadState } from '../request-workbench.types'
import { GrpcSchemaSource } from './GrpcSchemaSource'

interface GrpcSchemaControlsProps {
  grpc: GrpcCallState
  onChange: (patch: Partial<GrpcCallState>) => void
  schema: GrpcSchemaLoadState
  onLoad: (forceRefresh: boolean) => void
  rootPath: string
  disabled?: boolean
}

/** Keeps schema selection and service refresh beside the gRPC endpoint. */
export function GrpcSchemaControls({ grpc, onChange, schema, onLoad, rootPath, disabled = false }: GrpcSchemaControlsProps) {
  const { t } = useLanguage()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const isOpen = position !== null
  const width = Math.min(440, window.innerWidth - 16)

  if (disabled && isOpen) setPosition(null)

  useEffect(() => {
    if (!isOpen) return
    popupRef.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus()
    const close = () => setPosition(null)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
      triggerRef.current?.focus()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
    }
  }, [isOpen])

  return (
    <div className="rw-grpc-schema-controls">
      <button
        ref={triggerRef}
        type="button"
        className="rw-grpc-source-trigger"
        aria-label={t('grpc.schemaSource')}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => {
          if (isOpen) return setPosition(null)
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect) setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) })
        }}
      >
        <span>{t(grpc.schemaSource.type === 'reflection' ? 'grpc.sourceReflection' : 'grpc.sourceProtoFiles')}</span>
        <ChevronDownIcon size={12} />
      </button>
      <IconButton
        label={t('grpc.reloadServices')}
        icon={schema.status === 'loading' ? <Spinner size={14} /> : <RefreshIcon size={14} />}
        disabled={disabled || schema.status === 'loading'}
        aria-busy={schema.status === 'loading' || undefined}
        onClick={() => onLoad(true)}
      />
      {position && createPortal(
        <div ref={popupRef} className="rw-grpc-popup rw-grpc-source-popup" role="dialog" aria-label={t('grpc.schemaSource')}
          style={{ ...position, width }}>
          <GrpcSchemaSource grpc={grpc} onChange={onChange} rootPath={rootPath} />
        </div>,
        document.body,
      )}
    </div>
  )
}
