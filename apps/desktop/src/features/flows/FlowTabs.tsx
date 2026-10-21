import { useState } from 'react'

/** Finite tab sets share automatic keyboard activation and a single tab stop. */
export function FlowTabs<T extends string>({ items, value, onChange, label, className = '' }: { items: { id: T; label: string }[]; value: T; onChange: (value: T) => void; label: string; className?: string }) {
  // WebKitGTK applies :focus-visible to buttons clicked with the pointer, so the
  // list tracks the last interaction and only draws the focus ring for the keyboard.
  const [pointerInteraction, setPointerInteraction] = useState(false)
  return <div
    className={`flow-studio-tabs ${className}`}
    role="tablist"
    aria-label={label}
    data-pointer-interaction={pointerInteraction || undefined}
    onPointerDown={() => setPointerInteraction(true)}
    onKeyDown={() => setPointerInteraction(false)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPointerInteraction(false) }}
  >
    {items.map((item, index) => <button key={item.id} type="button" role="tab" tabIndex={value === item.id ? 0 : -1} aria-selected={value === item.id} onClick={() => onChange(item.id)} onKeyDown={(event) => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length : null
      if (next === null) return
      event.preventDefault()
      onChange(items[next].id)
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }}>{item.label}</button>)}
  </div>
}
