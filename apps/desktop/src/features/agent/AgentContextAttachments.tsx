import { useEffect, useId, useRef, useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { IconButton } from '../../shared/ui/IconButton'
import { AtIcon, ChevronDownIcon, CloseIcon, CopyIcon, PencilIcon, SelectionIcon, TrashIcon } from '../../shared/ui/icons'
import type { AgentContextOption } from './agent-context'

interface AgentContextAttachmentsProps {
  items: AgentContextOption[]
  onRemove: (item: AgentContextOption) => void
  onClear: () => void
  onEdit: (item: AgentContextOption, text: string) => void
  onReturnFocus: () => void
}

/** One compact attachment entry, with full messages and excerpts identified independently. */
export function AgentContextAttachments({ items, onRemove, onClear, onEdit, onReturnFocus }: AgentContextAttachmentsProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: Event) => {
      if (rootRef.current?.contains(event.target as Node | null)) return
      setOpen(false)
      setEditing(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [open])

  useEffect(() => {
    if (editing) editorRef.current?.focus()
  }, [editing])

  const close = () => {
    setOpen(false)
    setEditing(null)
    triggerRef.current?.focus()
  }
  const clear = () => {
    setOpen(false)
    setEditing(null)
    onClear()
    onReturnFocus()
  }

  if (items.length === 0) return null

  return (
    <div
      ref={rootRef}
      className="agent-attachments"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (editing) {
            setEditing(null)
            triggerRef.current?.focus()
          } else close()
        }
      }}
    >
      <div className="agent-attachments-chip">
        <button
          ref={triggerRef}
          type="button"
          className="agent-attachments-trigger"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => { setOpen(!open); setEditing(null) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          <AtIcon size={12} />
          <span>{t(items.length === 1 ? 'agent.context.count.one' : 'agent.context.count.many', { count: items.length })}</span>
          <ChevronDownIcon size={10} />
        </button>
        <IconButton icon={<CloseIcon size={10} />} label={t('agent.context.clear')} tooltip={false} onClick={clear} />
      </div>
      {open && (
        <section className="agent-attachments-popover" id={listId} aria-label={t('agent.context.attachedAria')}>
          <div className="agent-attachments-header">
            <span>{t('agent.context.attachedAria')}</span>
            <IconButton icon={<CloseIcon size={12} />} label={t('agent.context.close')} tooltip={false} onClick={close} />
          </div>
          <ol className="agent-attachments-list">
            {items.map((item, index) => {
              const partial = item.kind === 'selection' || item.quoteKind === 'selection'
              const type = partial ? t('agent.context.selectedText') : item.quoteKind === 'reply' ? t('agent.context.fullReply') : item.kind === 'quote' ? t('agent.context.fullMessage') : t(`agent.context.kind.${item.kind}`)
              const Icon = partial ? SelectionIcon : item.kind === 'quote' ? CopyIcon : AtIcon
              const preview = item.preview ?? (item.kind === 'quote' ? item.summary : item.label)
              return (
                <li key={`${item.kind}:${item.id}`} className="agent-attachment" data-kind={partial ? 'selection' : item.kind}>
                  <span className="agent-attachment-number" aria-hidden="true">{index + 1}.</span>
                  <div className="agent-attachment-content">
                    <span className="agent-attachment-type"><Icon size={12} />{type}</span>
                    {(item.kind === 'selection' || (item.kind === 'quote' && !partial)) && <span className="agent-attachment-source">{item.label}</span>}
                    {editing === item.id ? (
                      <div className="agent-attachment-editor">
                        <textarea ref={editorRef} rows={4} aria-label={t('agent.context.editText')} value={draft} onChange={(event) => setDraft(event.target.value)} />
                        <div>
                          <Button variant="ghost" onClick={() => { setEditing(null); triggerRef.current?.focus() }}>{t('agent.message.editCancel')}</Button>
                          <Button disabled={draft.trim() === ''} onClick={() => {
                            onEdit(item, draft.trim())
                            setEditing(null)
                            triggerRef.current?.focus()
                          }}>{t('agent.context.save')}</Button>
                        </div>
                      </div>
                    ) : <p className="agent-attachment-preview">{preview}</p>}
                  </div>
                  <div className="agent-attachment-actions">
                    {item.quoteKind === 'selection' && editing !== item.id && (
                      <IconButton icon={<PencilIcon size={12} />} label={t('agent.context.editAria', { number: index + 1 })} tooltip={false} onClick={() => { setDraft(item.summary); setEditing(item.id) }} />
                    )}
                    <IconButton icon={<TrashIcon size={12} />} label={t('agent.context.removeAria', { name: item.label })} tooltip={false} onClick={() => {
                      onRemove(item)
                      setEditing(null)
                      if (items.length === 1) { setOpen(false); onReturnFocus() }
                      else triggerRef.current?.focus()
                    }} />
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      )}
    </div>
  )
}
