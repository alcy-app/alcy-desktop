/** Display block icon, following the shared icon sizing and appearance settings. */
export function FlowDisplayIcon({ size = 15 }: { size?: number }) {
  const scaled = `calc(${size}px * var(--icon-scale, 1))`
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} style={{ width: scaled, height: scaled }} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2" width="13" height="9" rx="1.5" />
      <path d="M8 11v3m-3 0h6" />
    </svg>
  )
}
