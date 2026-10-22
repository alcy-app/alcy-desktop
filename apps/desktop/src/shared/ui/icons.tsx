import './spinner.css'

interface IconProps {
  size?: number
  className?: string
}

/** `width`/`height` provide a fallback; styles apply the icon scale
 * (`--icon-scale`, adjustable in Settings) without changing callers. */
function svgProps({ size = 14, className }: IconProps) {
  const scaled = `calc(${size}px * var(--icon-scale, 1))`
  return {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    style: { width: scaled, height: scaled },
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className,
  } as const
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M10 4L6 8l4 4" />
    </svg>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

/** Two server units with status indicators, used for mock servers. */
export function MockServerIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.25" y="2.25" width="11.5" height="4.5" rx="1" />
      <rect x="2.25" y="9.25" width="11.5" height="4.5" rx="1" />
      <path d="M4.5 4.5h.01M4.5 11.5h.01M7 4.5h4.5M7 11.5h4.5" />
    </svg>
  )
}

export function CollapseAllIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 2.5L8 6l3.5-3.5" />
      <path d="M4.5 13.5L8 10l3.5 3.5" />
    </svg>
  )
}

export function ExpandAllIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 6L8 2.5 11.5 6" />
      <path d="M4.5 10L8 13.5l3.5-3.5" />
    </svg>
  )
}

export function LocateIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="3.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
    </svg>
  )
}

export function EllipsisIcon(props: IconProps) {
  const base = svgProps(props)
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M11.3 2.9l1.8 1.8L5.4 12.4l-2.5.7.7-2.5z" />
    </svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8c.05.8.7 1.5 1.5 1.5h3c.8 0 1.45-.7 1.5-1.5l.5-8" />
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h3l1.2 1.4h6.4c.7 0 1.2.6 1.2 1.2v6.2c0 .7-.6 1.2-1.2 1.2H2.7c-.7 0-1.2-.6-1.2-1.2z" />
    </svg>
  )
}

export function BranchIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="3.5" cy="8" r="1.6" />
      <circle cx="12.5" cy="4" r="1.6" />
      <circle cx="12.5" cy="12" r="1.6" />
      <path d="M5.1 8h1.4c1.1 0 1.7-.6 2.3-1.3l.7-.8c.6-.7 1.2-1.3 2.3-1.3h.7M5.1 8h1.4c1.1 0 1.7.6 2.3 1.3l.7.8c.6.7 1.2 1.3 2.3 1.3h.7" />
    </svg>
  )
}

export function FlowIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="3" cy="4" r="1.8" />
      <circle cx="13" cy="4" r="1.8" />
      <circle cx="8" cy="12.5" r="1.8" />
      <path d="M4.6 5.2L7 11M11.4 5.2L9 11" />
    </svg>
  )
}

export function BlockIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 2l5.5 3.2v5.6L8 14l-5.5-3.2V5.2z" />
      <path d="M8 8v6M8 8L2.5 5.2M8 8l5.5-2.8" />
    </svg>
  )
}

export function GlobeIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13" />
      <path d="M8 1.5c2.2 1.9 2.2 11.1 0 13M8 1.5c-2.2 1.9-2.2 11.1 0 13" />
    </svg>
  )
}

/** A shield with a network node represents traffic passing through a proxy. */
export function ProxyIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 1.5 13.5 3.5v4c0 3.2-2.3 5.7-5.5 7-3.2-1.3-5.5-3.8-5.5-7v-4L8 1.5Z" />
      <circle cx="8" cy="7.5" r="1.4" />
      <path d="M8 4.8v1.3M8 8.9v1.3M5.7 7.5H4.7M11.3 7.5h-1" />
    </svg>
  )
}

/** Braces represent the variables that make up an environment. */
export function VariablesIcon(props: IconProps) {
  const base = svgProps(props)
  return (
    <svg {...base}>
      <path d="M6 2.5h-.8c-.9 0-1.4.5-1.4 1.4v1.8c0 1.1-.5 1.8-1.5 2.3 1 .5 1.5 1.2 1.5 2.3v1.8c0 .9.5 1.4 1.4 1.4H6" />
      <path d="M10 2.5h.8c.9 0 1.4.5 1.4 1.4v1.8c0 1.1.5 1.8 1.5 2.3-1 .5-1.5 1.2-1.5 2.3v1.8c0 .9-.5 1.4-1.4 1.4H10" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

const GEAR_TOOTH_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315]

export function GearIcon(props: IconProps) {
  const base = svgProps(props)
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <path
        fillRule="evenodd"
        d="M3.7,8 A4.3,4.3 0 1,0 12.3,8 A4.3,4.3 0 1,0 3.7,8 Z M5.9,8 A2.1,2.1 0 1,0 10.1,8 A2.1,2.1 0 1,0 5.9,8 Z"
      />
      {GEAR_TOOTH_ANGLES.map((angle) => (
        <rect key={angle} x="6.8" y="2.3" width="2.4" height="2" rx="0.4" transform={`rotate(${angle} 8 8)`} />
      ))}
    </svg>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  )
}

export function WorkspaceIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 1.75l5.25 3v6.5L8 14.25l-5.25-3v-6.5L8 1.75z" />
      <path d="M2.75 4.75L8 7.75l5.25-3M8 7.75v6.5" />
    </svg>
  )
}

export function ComponentsIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  )
}

/** Binoculars represent monitoring response values. */
export function MonitorIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 13.5a1.2 1.2 0 0 1-1.2-1.2V10c0-.9 1.3-1.9 1.3-3.1V5.4a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v7a1.1 1.1 0 0 1-1.1 1.1z" />
      <path d="M13.5 13.5a1.2 1.2 0 0 0 1.2-1.2V10c0-.9-1.3-1.9-1.3-3.1V5.4a.7.7 0 0 0-.7-.7h-2.6a.7.7 0 0 0-.7.7v7a1.1 1.1 0 0 0 1.1 1.1z" />
      <path d="M3.3 4.7V3a.6.6 0 0 1 .6-.6h1.2a.6.6 0 0 1 .6.6v1.7M12.7 4.7V3a.6.6 0 0 0-.6-.6h-1.2a.6.6 0 0 0-.6.6v1.7" />
      <path d="M6.6 6.8h2.8M1.3 10.6h5.3M9.4 10.6h5.3" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.8v3.9" />
      <circle cx="8" cy="11.2" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function EyeIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8s-2.3 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

export function EyeOffIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2 2l12 12" />
      <path d="M6.6 3.9C7 3.8 7.5 3.7 8 3.7c4.2 0 6.5 4.3 6.5 4.3s-.7 1.4-2 2.7M4.6 5.3C2.7 6.6 1.5 8 1.5 8S3.8 12.3 8 12.3c.9 0 1.7-.2 2.4-.5" />
      <path d="M6.6 9.4a2 2 0 0 0 2.8 2" />
    </svg>
  )
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2 3h12l-4.6 5.4v4.1L6.6 14V8.4L2 3z" />
    </svg>
  )
}

/** Lines sorted by length and an up arrow indicate sorting from A to Z. */
export function SortAscendingIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 3.5h6M2.5 6.5h4M2.5 9.5h2" />
      <path d="M12 12.5v-9M10 5.5l2-2 2 2" />
    </svg>
  )
}

/** Lines sorted by length and a down arrow indicate sorting from Z to A. */
export function SortDescendingIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 3.5h2M2.5 6.5h4M2.5 9.5h6" />
      <path d="M12 3.5v9M10 10.5l2 2 2-2" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="M13.5 13.5l-3.3-3.3" />
    </svg>
  )
}

export function SaveIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 2.5h8.4l2.6 2.6v8.4h-11z" />
      <path d="M4.5 2.5v3.5h5.5V2.5" />
      <path d="M4.7 13.3V9.3h6.6v4" />
    </svg>
  )
}

export function SendIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2 8l11.5-5.5L9 13.5l-1.6-4.9z" />
      <path d="M7.4 8.6L13.5 2.5" />
    </svg>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5V3.7c0-.66-.54-1.2-1.2-1.2H3.7c-.66 0-1.2.54-1.2 1.2v5.6c0 .66.54 1.2 1.2 1.2h1.8" />
    </svg>
  )
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 2v7.5M4.8 6.7L8 9.9l3.2-3.2" />
      <path d="M2.5 11.5v1.3c0 .7.6 1.2 1.2 1.2h8.6c.7 0 1.2-.6 1.2-1.2v-1.3" />
    </svg>
  )
}

/** A document with an incoming arrow represents importing an external file. */
export function ImportIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M6 5V3.2c0-.4.3-.7.7-.7h3.8l3 3v7.3c0 .4-.3.7-.7.7H6.7c-.4 0-.7-.3-.7-.7V11" />
      <path d="M10.5 2.5v3h3" />
      <path d="M1.5 8h7M6.3 5.8L8.5 8l-2.2 2.2" />
    </svg>
  )
}

export function PanelLeftIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </svg>
  )
}

export function PanelRightIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </svg>
  )
}

export function PanelBottomIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 8h13" />
    </svg>
  )
}

export function FormatIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2 3.5h12M2 8h8M2 12.5h10" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <polyline points="15.33 2.67 15.33 6.67 11.33 6.67" />
      <polyline points="0.67 13.33 0.67 9.33 4.67 9.33" />
      <path d="M2.34 6a6 6 0 0 1 9.9-2.24L15.33 6.67M0.67 9.33l3.09 2.91A6 6 0 0 0 13.66 10" />
    </svg>
  )
}

/** Pull changes from the remote branch. */
export function GitPullIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 2.5v9" />
      <path d="M4.8 8.5L8 11.7l3.2-3.2" />
      <path d="M3 13.5h10" />
    </svg>
  )
}

/** Push local changes to the remote branch. */
export function GitPushIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 13.5v-9" />
      <path d="M4.8 7.5L8 4.3l3.2 3.2" />
      <path d="M3 2.5h10" />
    </svg>
  )
}

export function MinimizeIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 8h10" />
    </svg>
  )
}

export function MaximizeIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  )
}

export function RestoreIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="5" y="5" width="7.5" height="7.5" rx="1" />
      <path d="M3.5 9.5v-5c0-.55.45-1 1-1h5" />
    </svg>
  )
}

export function TerminalIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.2 6l2.3 2-2.3 2M8 10.3h3.8" />
    </svg>
  )
}

export function RecordIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function Spinner({ size = 14, className }: IconProps) {
  const base = svgProps({ size, className: className ? `ui-spinner ${className}` : 'ui-spinner' })
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="6" strokeOpacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" />
    </svg>
  )
}

/** A version control branch. */
export function GitIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="4.5" cy="3.5" r="1.4" />
      <circle cx="4.5" cy="12.5" r="1.4" />
      <circle cx="11.5" cy="6" r="1.4" />
      <path d="M4.5 4.9v6.2M11.5 7.4c0 2.2-2.5 2.6-7 3.4" />
    </svg>
  )
}

/** Favorite star; `filled` marks the item as a favorite. */
export function StarIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...svgProps(props)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8z" />
    </svg>
  )
}

export function TagIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6V2.5z" />
      <circle cx="5.3" cy="5.3" r="0.9" />
    </svg>
  )
}

export function PinIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path transform="rotate(45 8 8)" d="M5.5 2.5h5M6.4 2.5v3.7L4.5 8h7L9.6 6.2V2.5M8 8v6" />
    </svg>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7" />
    </svg>
  )
}

export function KeyboardIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="1.5" y="3.8" width="13" height="8.4" rx="1.5" />
      <path d="M4.2 6.6h.01M6.7 6.6h.01M9.3 6.6h.01M11.8 6.6h.01M5.2 9.5h5.6" />
    </svg>
  )
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3l1-1z" />
      <path d="M6.6 13.5a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  )
}

export function ShareIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="3.5" r="1.7" />
      <circle cx="4" cy="8" r="1.7" />
      <circle cx="12" cy="12.5" r="1.7" />
      <path d="M5.5 7.2l5-2.9M5.5 8.8l5 2.9" />
    </svg>
  )
}

/** A speedometer represents load and performance testing. */
export function LoadTestIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.5 12.5a6 6 0 1 1 9 0" />
      <path d="M8 3.5v1M3 8.5h1M12 8.5h1M8 8.5l2.5-2.5" />
      <circle cx="8" cy="8.5" r=".7" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Collection runner: a play symbol beside a list of requests. */
export function RunnerIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.2 4.6v6.8L7.2 8z" />
      <path d="M9.5 4h4.3M9.5 8h4.3M9.5 12h4.3" />
    </svg>
  )
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 2.8v10.4L12.8 8z" fill="currentColor" />
    </svg>
  )
}

export function StopIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  )
}

/** Six-dot drag handle. */
export function GripIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01" strokeWidth={2.2} />
    </svg>
  )
}

export function FolderOpenIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V7" />
      <path d="M2 12.5l1.8-4.6a1 1 0 0 1 .93-.64H14l-1.9 4.9a.6.6 0 0 1-.56.34H2z" />
    </svg>
  )
}
